use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobSpec {
    pub prompt: String,
    pub input: Option<PathBuf>,
    pub output_format: String,
    pub output_version: String,
    pub max_corrections: u32,
    pub max_evolution_steps: u32,
}

impl JobSpec {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.prompt.trim().is_empty() && self.prompt.len() <= 64000,
            "prompt must contain 1..64000 bytes"
        );
        ensure!(
            ["dwg", "dxf"].contains(&self.output_format.as_str()),
            "output format must be dwg or dxf"
        );
        ensure!(
            ["2000", "2004", "2007", "2010", "2013", "2018"]
                .contains(&self.output_version.as_str()),
            "unsupported delivery version"
        );
        ensure!(
            self.max_corrections <= 10 && self.max_evolution_steps <= 10,
            "agent iteration budget exceeds 10"
        );
        if let Some(path) = &self.input {
            ensure!(
                path.is_absolute() && path.is_file(),
                "input must be an existing absolute drawing path"
            );
            ensure!(
                path.extension()
                    .and_then(|p| p.to_str())
                    .is_some_and(|p| ["dwg", "dxf"].contains(&p.to_ascii_lowercase().as_str())),
                "input must be DWG or DXF"
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub spec: JobSpec,
    pub status: String,
    pub stage: String,
    pub output: PathBuf,
    pub error: Option<String>,
}

pub struct Queue {
    conn: Connection,
}

impl Queue {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).context("open job queue")?;
        conn.busy_timeout(Duration::from_secs(10))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, spec TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
                stage TEXT NOT NULL DEFAULT 'queued', output TEXT NOT NULL, owner TEXT,
                heartbeat INTEGER, created INTEGER NOT NULL DEFAULT (unixepoch()),
                updated INTEGER NOT NULL DEFAULT (unixepoch()), error TEXT);
            CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status, created);
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at INTEGER NOT NULL DEFAULT (unixepoch()),
                stage TEXT NOT NULL, payload TEXT NOT NULL);")?;
        Ok(Self { conn })
    }

    pub fn enqueue(&self, spec: &JobSpec, output_root: &Path) -> Result<String> {
        spec.validate()?;
        ensure!(output_root.is_absolute(), "output root must be absolute");
        let id = Uuid::new_v4().to_string();
        let output = output_root.join(&id);
        self.conn.execute(
            "INSERT INTO jobs(id,spec,output) VALUES(?1,?2,?3)",
            params![
                id,
                serde_json::to_string(spec)?,
                output.to_str().context("non UTF-8 output path")?
            ],
        )?;
        Ok(id)
    }

    pub fn claim(&mut self, owner: &str) -> Result<Option<Job>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM jobs WHERE status='queued' ORDER BY created,id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = &id {
            tx.execute("UPDATE jobs SET status='running',owner=?2,heartbeat=unixepoch(),updated=unixepoch(),stage='starting' WHERE id=?1 AND status='queued'", params![id, owner])?;
        }
        tx.commit()?;
        id.map(|id| self.get(&id)).transpose()
    }

    pub fn get(&self, id: &str) -> Result<Job> {
        let (spec, status, stage, output, error): (String, String, String, String, Option<String>) =
            self.conn.query_row(
                "SELECT spec,status,stage,output,error FROM jobs WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?;
        Ok(Job {
            id: id.into(),
            spec: serde_json::from_str(&spec)?,
            status,
            stage,
            output: output.into(),
            error,
        })
    }

    pub fn heartbeat(&self, id: &str, owner: &str) -> Result<()> {
        ensure!(self.conn.execute("UPDATE jobs SET heartbeat=unixepoch(),updated=unixepoch() WHERE id=?1 AND owner=?2 AND status='running'", params![id,owner])? == 1, "job lease was lost");
        Ok(())
    }

    pub fn checkpoint(
        &mut self,
        id: &str,
        owner: &str,
        stage: &str,
        payload: &serde_json::Value,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure!(tx.execute("UPDATE jobs SET stage=?3,heartbeat=unixepoch(),updated=unixepoch() WHERE id=?1 AND owner=?2 AND status='running'", params![id,owner,stage])? == 1, "job lease was lost");
        tx.execute(
            "INSERT INTO events(job_id,stage,payload) VALUES(?1,?2,?3)",
            params![id, stage, serde_json::to_string(payload)?],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn finish(&self, id: &str, owner: &str, error: Option<&str>) -> Result<()> {
        let status = if error.is_some() {
            "failed"
        } else {
            "completed"
        };
        ensure!(self.conn.execute("UPDATE jobs SET status=?3,error=?4,stage=?3,updated=unixepoch() WHERE id=?1 AND owner=?2 AND status='running'", params![id,owner,status,error])? == 1, "job lease was lost");
        Ok(())
    }

    pub fn recover_expired(&self, seconds: u64) -> Result<usize> {
        ensure!(
            seconds >= 60 && seconds <= i64::MAX as u64,
            "lease timeout must be at least 60 seconds"
        );
        // A CAD mutation might have committed before the worker died. Requeueing could duplicate geometry.
        Ok(self.conn.execute("UPDATE jobs SET status='interrupted',error='Worker lease expired; inspect artifacts and submit a new job with a verified drawing. No mutation was replayed.',updated=unixepoch() WHERE status='running' AND heartbeat < unixepoch()-?1", [seconds as i64])?)
    }

    pub fn events(&self, id: &str) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT at,stage,payload FROM events WHERE job_id=?1 ORDER BY seq")?;
        let rows = stmt.query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (at, stage, payload) = row?;
            out.push(serde_json::json!({"at":at,"stage":stage,"payload":serde_json::from_str::<serde_json::Value>(&payload)?}));
        }
        Ok(out)
    }

    pub fn cancel_queued(&self, id: &str) -> Result<()> {
        if self.conn.execute("UPDATE jobs SET status='cancelled',stage='cancelled',updated=unixepoch() WHERE id=?1 AND status='queued'", [id])? != 1 { bail!("only queued jobs can be cancelled"); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec() -> JobSpec {
        JobSpec {
            prompt: "A 6000 x 8000mm house".into(),
            input: None,
            output_format: "dxf".into(),
            output_version: "2000".into(),
            max_corrections: 2,
            max_evolution_steps: 2,
        }
    }
    #[test]
    fn durable_claim_and_owner_fencing() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let db = dir.path().join("jobs.sqlite");
        let mut a = Queue::open(&db)?;
        let mut b = Queue::open(&db)?;
        let id = a.enqueue(&spec(), dir.path())?;
        assert_eq!(a.claim("a")?.context("claim")?.id, id);
        assert!(b.claim("b")?.is_none());
        assert!(b.heartbeat(&id, "b").is_err());
        a.checkpoint(&id, "a", "planning", &serde_json::json!({"phase":1}))?;
        a.finish(&id, "a", None)?;
        drop(a);
        assert_eq!(Queue::open(&db)?.get(&id)?.status, "completed");
        assert_eq!(b.events(&id)?.len(), 1);
        Ok(())
    }
    #[test]
    fn expired_jobs_are_not_replayed() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut q = Queue::open(&dir.path().join("q.sqlite"))?;
        let id = q.enqueue(&spec(), dir.path())?;
        q.claim("old")?;
        q.conn
            .execute("UPDATE jobs SET heartbeat=0 WHERE id=?1", [&id])?;
        assert_eq!(q.recover_expired(60)?, 1);
        assert!(q.claim("new")?.is_none());
        assert_eq!(q.get(&id)?.status, "interrupted");
        assert!(q.heartbeat(&id, "old").is_err());
        Ok(())
    }
    #[test]
    fn reject_invalid_spec() {
        let mut s = spec();
        s.max_corrections = 100;
        assert!(s.validate().is_err());
        s = spec();
        s.output_format = "pdf".into();
        assert!(s.validate().is_err());
    }
}
