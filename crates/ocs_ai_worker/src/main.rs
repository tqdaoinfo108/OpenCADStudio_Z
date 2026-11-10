use anyhow::{ensure, Context, Result};
use clap::{Parser, Subcommand};
use ocs_ai_worker::{
    bridge::CadSession,
    openai::OpenAi,
    orchestrator::{Orchestrator, WorkerConfig},
    queue::{JobSpec, Queue},
    spatial,
};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

#[derive(Parser)]
#[command(
    version,
    about = "Durable, fail-closed OpenAI Prompt-to-CAD worker (MCP editor required)"
)]
struct Cli {
    #[arg(
        long,
        env = "OCS_AI_QUEUE",
        default_value = "target/ai-worker/jobs.sqlite"
    )]
    database: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Enqueue a design requirement, optionally developing an existing DWG/DXF.
    Submit {
        #[arg(long)]
        prompt: String,
        #[arg(long)]
        input: Option<PathBuf>,
        #[arg(long, default_value = "dxf")]
        format: String,
        #[arg(long, default_value = "2000")]
        version: String,
        #[arg(long, default_value_t = 2)]
        max_corrections: u32,
        #[arg(long, default_value_t = 3)]
        max_evolution_steps: u32,
        #[arg(long, default_value = "target/ai-worker/artifacts")]
        output: PathBuf,
    },
    /// Inspect durable status and event journal.
    Status {
        id: String,
        #[arg(long)]
        events: bool,
    },
    /// Cancel a job which has not started.
    Cancel { id: String },
    /// Run until Ctrl-C. Explicit distinct editor sessions enable a process pool.
    Daemon {
        #[arg(long, env = "OCS_EXECUTABLE")]
        executable: PathBuf,
        #[arg(long = "session")]
        sessions: Vec<String>,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
        #[arg(long, default_value_t = 24)]
        max_tool_rounds: usize,
        #[arg(long, default_value_t = 2)]
        poll_seconds: u64,
        /// Claim at most one job per pool slot and exit.
        #[arg(long)]
        once: bool,
    },
    /// Mark jobs whose heartbeat expired as interrupted; NEVER replay CAD mutations.
    Recover {
        #[arg(long, default_value_t = 600)]
        lease_seconds: u64,
    },
    /// Print the strict parametric plan schema without needing API credentials.
    Schema,
    /// Validate real MCP discovery; --openai also calls the configured OpenAI endpoint.
    Check {
        #[arg(long, env = "OCS_EXECUTABLE")]
        executable: PathBuf,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        openai: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Schema => println!("{}", serde_json::to_string_pretty(&spatial::plan_schema())?),
        Command::Submit {
            prompt,
            input,
            format,
            version,
            max_corrections,
            max_evolution_steps,
            output,
        } => {
            let input = input
                .map(fs::canonicalize)
                .transpose()
                .context("resolve input drawing")?;
            let output = std::path::absolute(output)?;
            let id = Queue::open(&cli.database)?.enqueue(
                &JobSpec {
                    prompt,
                    input,
                    output_format: format,
                    output_version: version,
                    max_corrections,
                    max_evolution_steps,
                },
                &output,
            )?;
            println!("{}", json!({"job_id":id,"status":"queued"}));
        }
        Command::Status { id, events } => {
            let q = Queue::open(&cli.database)?;
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &json!({"job":q.get(&id)?,"events":if events {q.events(&id)?}else{vec![]}})
                )?
            );
        }
        Command::Cancel { id } => {
            Queue::open(&cli.database)?.cancel_queued(&id)?;
            println!("{}", json!({"job_id":id,"status":"cancelled"}));
        }
        Command::Recover { lease_seconds } => {
            println!(
                "{}",
                json!({"interrupted":Queue::open(&cli.database)?.recover_expired(lease_seconds)?})
            );
        }
        Command::Check {
            executable,
            session,
            openai,
        } => {
            let executable = fs::canonicalize(executable)?;
            let mut cad =
                CadSession::connect(&executable, Duration::from_secs(300), session.as_deref())?;
            let tools = cad.client.tools()?;
            ensure!(
                tools.len() == 20,
                "expected the documented 20 MCP tools, got {}",
                tools.len()
            );
            let capabilities = cad.read("capabilities", json!({}))?;
            let ai = if openai {
                let ai = OpenAi::from_env()?;
                let response:Value=ai.structured("connectivity_check",json!({"type":"object","additionalProperties":false,"properties":{"ready":{"type":"boolean"}},"required":["ready"]}),"This is a real API connectivity test. Return ready=true.",json!("Confirm structured output availability."),false)?;
                ensure!(response["ready"] == true, "OpenAI check did not pass");
                response
            } else {
                Value::Null
            };
            println!(
                "{}",
                json!({"session_id":cad.session_id,"tools":tools.iter().map(|t|t["name"].clone()).collect::<Vec<_>>(),"capabilities":capabilities,"openai":ai})
            );
        }
        Command::Daemon {
            executable,
            sessions,
            timeout_seconds,
            max_tool_rounds,
            poll_seconds,
            once,
        } => {
            ensure!(
                (10..=1800).contains(&timeout_seconds),
                "CAD timeout must be 10..1800 seconds"
            );
            ensure!(
                (1..=64).contains(&max_tool_rounds),
                "tool rounds must be 1..64"
            );
            ensure!(
                (1..=60).contains(&poll_seconds),
                "poll interval must be 1..60 seconds"
            );
            let executable =
                fs::canonicalize(executable).context("resolve OpenCADStudio executable")?;
            let db = std::path::absolute(cli.database)?;
            Queue::open(&db)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(db.with_extension("daemon.lock"))?;
            lock.try_lock()
                .context("another daemon already owns this queue")?;
            let mut unique = sessions.clone();
            unique.sort();
            unique.dedup();
            ensure!(
                unique.len() == sessions.len(),
                "pool sessions must be distinct"
            );
            ensure!(
                sessions.len() <= 8,
                "pool is limited to eight explicit editor sessions"
            );
            let slots: Vec<Option<String>> = if sessions.is_empty() {
                vec![None]
            } else {
                sessions.into_iter().map(Some).collect()
            };
            let stop = Arc::new(AtomicBool::new(false));
            let signal = stop.clone();
            ctrlc::set_handler(move || {
                signal.store(true, Ordering::SeqCst);
            })?;
            // Check credentials before accepting any job. The key stays only in process memory.
            OpenAi::from_env()?;
            let mut workers = Vec::new();
            for session_id in slots {
                let db = db.clone();
                let config = WorkerConfig {
                    executable: executable.clone(),
                    session_id,
                    timeout: Duration::from_secs(timeout_seconds),
                    max_tool_rounds,
                    stop: stop.clone(),
                };
                workers.push(thread::spawn(move || {
                    run_slot(db, config, Duration::from_secs(poll_seconds), once)
                }));
            }
            let mut errors = Vec::new();
            for worker in workers {
                match worker.join() {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => errors.push(error.to_string()),
                    Err(_) => errors.push("worker thread panicked".into()),
                }
            }
            ensure!(errors.is_empty(), "worker failures: {}", errors.join("; "));
            drop(lock);
        }
    }
    Ok(())
}

fn run_slot(db: PathBuf, config: WorkerConfig, poll: Duration, once: bool) -> Result<()> {
    let owner = Uuid::new_v4().to_string();
    let mut queue = Queue::open(&db)?;
    let orchestrator = Orchestrator {
        ai: OpenAi::from_env()?,
        config: config.clone(),
    };
    loop {
        if config.stop.load(Ordering::SeqCst) {
            break;
        }
        let Some(job) = queue.claim(&owner)? else {
            if once {
                break;
            }
            thread::sleep(poll);
            continue;
        };
        eprintln!("job {} started", job.id);
        let heartbeat_stop = Arc::new(AtomicBool::new(false));
        let done = heartbeat_stop.clone();
        let db = db.clone();
        let id = job.id.clone();
        let heartbeat_owner = owner.clone();
        let shutdown = config.stop.clone();
        let heartbeat = thread::spawn(move || -> Result<()> {
            let q = Queue::open(&db)?;
            while !done.load(Ordering::SeqCst) {
                if let Err(error) = q.heartbeat(&id, &heartbeat_owner) {
                    shutdown.store(true, Ordering::SeqCst);
                    return Err(error);
                }
                for _ in 0..50 {
                    if done.load(Ordering::SeqCst) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
            Ok(())
        });
        let result = orchestrator.process(&job, |stage, payload| {
            queue.checkpoint(&job.id, &owner, stage, payload)
        });
        heartbeat_stop.store(true, Ordering::SeqCst);
        let beat = heartbeat
            .join()
            .map_err(|_| anyhow::anyhow!("heartbeat thread panicked"))?;
        let result = result.and_then(|report| {
            beat?;
            Ok(report)
        });
        match result {
            Ok(_) => {
                queue.finish(&job.id, &owner, None)?;
                eprintln!("job {} completed and verified", job.id);
            }
            Err(error) => {
                let error = format!("{error:#}");
                if job.output.is_dir() {
                    let path = job.output.join("failure.json");
                    if let Ok(file) = OpenOptions::new().write(true).create_new(true).open(path) {
                        let _ = serde_json::to_writer_pretty(
                            file,
                            &json!({"ok":false,"job_id":job.id,"error":error,"replayed":false}),
                        );
                    }
                }
                queue.finish(&job.id, &owner, Some(&error))?;
                eprintln!("job {} failed: {}", job.id, error);
                if once {
                    anyhow::bail!(
                        "job {} failed; inspect status and failure artifacts",
                        job.id
                    );
                }
            }
        }
        if once {
            break;
        }
    }
    Ok(())
}
