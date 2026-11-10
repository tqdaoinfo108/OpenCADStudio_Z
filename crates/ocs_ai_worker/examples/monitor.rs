use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ocs_ai_worker::bridge::McpClient;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const INTERVAL: Duration = Duration::from_secs(8);
const HTTP_TIMEOUT: Duration = Duration::from_secs(3);
const JSON_LIMIT: u64 = 16 * 1024 * 1024;
const DOCUMENT: u64 = 2;
const CHECKPOINT: &str = "actual/checkpoint-incomplete.dwg";
#[derive(Clone, Default, Serialize)]
struct Progress {
    total: usize,
    completed: usize,
    prepared: usize,
    unacknowledged: Vec<usize>,
}
#[derive(Clone, Default, Serialize)]
struct Status {
    connected: bool,
    state: Option<Value>,
    error: Option<String>,
    updated_unix: Option<u64>,
    image_updated_unix: Option<u64>,
    progress: Progress,
    logs: Vec<String>,
    checkpoint_available: bool,
    delivery_complete: bool,
}
#[derive(Default)]
struct Snapshot {
    status: Status,
    png: Option<Arc<Vec<u8>>>,
}
type Shared = Arc<Mutex<Snapshot>>;
fn now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}
fn fixed_file(root: &Path, relative: &str) -> Result<File> {
    let path = fs::canonicalize(root.join(relative)).context("Artifact file unavailable")?;
    ensure!(path.starts_with(root), "Artifact escapes root");
    let file = File::open(path)?;
    ensure!(file.metadata()?.is_file(), "Artifact is not a regular file");
    Ok(file)
}
fn read_json(root: &Path, relative: &str) -> Result<Value> {
    let file = fixed_file(root, relative)?;
    ensure!(
        file.metadata()?.len() <= JSON_LIMIT,
        "Artifact JSON too large"
    );
    let mut bytes = Vec::new();
    file.take(JSON_LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= JSON_LIMIT, "Artifact JSON too large");
    Ok(serde_json::from_slice(&bytes)?)
}
fn acknowledged(value: &Value, expected: usize) -> bool {
    value.get("ok") != Some(&json!(false))
        && value.get("failed_steps").and_then(Value::as_u64) == Some(0)
        && value.get("completed_steps").and_then(Value::as_u64) == Some(expected as u64)
        && value.get("status").is_none_or(|v| v == "completed")
        && value
            .get("attention")
            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
}
fn progress(root: &Path) -> Result<Progress> {
    let phases = read_json(root, "phases.json")?;
    let phases = phases.as_array().context("phases.json must be an array")?;
    let mut progress = Progress {
        total: phases.len(),
        ..Progress::default()
    };
    for (index, phase) in phases.iter().enumerate() {
        let steps = phase
            .get("steps")
            .and_then(Value::as_array)
            .context("Phase has no steps")?;
        let prepared = fixed_file(root, &format!("actual/phase-{index:03}-prepared.json")).is_ok();
        let completed = read_json(root, &format!("actual/phase-{index:03}-result.json"))
            .is_ok_and(|value| acknowledged(&value, steps.len()));
        progress.prepared += usize::from(prepared);
        progress.completed += usize::from(completed);
        if prepared && !completed {
            progress.unacknowledged.push(index + 1);
        }
    }
    Ok(progress)
}
fn log_tail(root: &Path, relative: &str) -> Result<Vec<String>> {
    let mut file = fixed_file(root, relative)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(16 * 1024);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(16 * 1024).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let text = if start > 0 {
        text.split_once('\n').map_or("", |(_, tail)| tail)
    } else {
        &text
    };
    Ok(text
        .lines()
        .map(|line| format!("{relative}: {line}"))
        .collect())
}
fn final_delivery(root: &Path, progress: &Progress, session: &str) -> bool {
    // A checkpoint audit/save is not evidence that the house or final deliveries are complete.
    if progress.total == 0
        || progress.completed != progress.total
        || !progress.unacknowledged.is_empty()
    {
        return false;
    }
    let verify = || -> Result<()> {
        let report = read_json(root, "actual/report.json")?;
        ensure!(
            report["ok"] == true
                && report["session_id"] == session
                && report["document_id"] == DOCUMENT
                && report["phases"] == progress.total,
            "Final report does not match execution"
        );
        let audit = read_json(root, "actual/audit.json")?;
        ensure!(
            audit["ok"] == true && audit.pointer("/target/lossless") == Some(&json!(true)),
            "Final audit missing"
        );
        for format in ["dwg", "dxf"] {
            let saved = read_json(root, &format!("actual/delivery-{format}-result.json"))?;
            ensure!(saved["ok"] != false, "Final save failed");
            let result = saved.get("result").unwrap_or(&saved);
            ensure!(result["verified"] == true, "Final save not verified");
            let mut file = fixed_file(root, &format!("actual/nha-4-tang-10x15m.{format}"))?;
            let length = file.metadata()?.len();
            ensure!(
                length > 0 && length <= 128 * 1024 * 1024,
                "Final file size invalid"
            );
            let mut digest = Sha256::new();
            let mut buffer = [0; 16384];
            let mut limited = (&mut file).take(length + 1);
            let mut total = 0;
            loop {
                let count = limited.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                total += count as u64;
                digest.update(&buffer[..count]);
            }
            ensure!(total == length, "Final file changed during verification");
            let hash = format!("{:x}", digest.finalize());
            ensure!(
                result["sha256"].as_str() == Some(hash.as_str()),
                "Final file hash mismatch"
            );
        }
        Ok(())
    };
    verify().is_ok()
}
fn artifacts(root: &Path, session: &str, status: &mut Status) -> Result<()> {
    status.checkpoint_available = fixed_file(root, CHECKPOINT).is_ok();
    status.logs.clear();
    for name in ["execution.out.log", "execution.err.log"] {
        match log_tail(root, name) {
            Ok(lines) => status.logs.extend(lines),
            Err(_) => status.logs.push(format!("{name}: unavailable")),
        }
    }
    status.delivery_complete = false;
    status.progress = progress(root)?;
    status.delivery_complete = final_delivery(root, &status.progress, session);
    Ok(())
}
fn publish(shared: &Shared, status: &Status, png: &Option<Arc<Vec<u8>>>) -> Result<()> {
    let mut snapshot = shared
        .lock()
        .map_err(|_| anyhow::anyhow!("Snapshot lock poisoned"))?;
    snapshot.status = status.clone();
    snapshot.png = png.clone();
    Ok(())
}
fn capture(client: &mut McpClient, session: &str) -> Result<Vec<u8>> {
    let full = client.call_tool(
        "ocs_capture",
        json!({
            "ocs_session_id":session, "view":"current", "scope":"viewport",
            "max_dimension":1600, "delivery":"inline"
        }),
    )?;
    ensure!(full["isError"] != true, "Viewport capture refused");
    let content = full["content"]
        .as_array()
        .context("Capture content missing")?;
    let mut images = content
        .iter()
        .filter(|v| v["type"] == "image" && v["mimeType"] == "image/png");
    let image = images.next().context("No actual inline PNG returned")?;
    ensure!(images.next().is_none(), "Multiple capture images returned");
    let encoded = image["data"].as_str().context("PNG data missing")?;
    ensure!(
        encoded.len() <= 24 * 1024 * 1024,
        "Capture exceeds size limit"
    );
    let bytes = STANDARD.decode(encoded).context("Invalid capture base64")?;
    ensure!(
        bytes.len() >= 33
            && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
            && bytes[8..12] == 13u32.to_be_bytes()
            && &bytes[12..16] == b"IHDR",
        "Invalid PNG header"
    );
    let width = u32::from_be_bytes(bytes[16..20].try_into()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into()?);
    ensure!(
        width > 0 && height > 0 && width <= 1600 && height <= 1600,
        "Invalid capture dimensions"
    );
    Ok(bytes)
}
fn poll(root: PathBuf, executable: PathBuf, session: String, shared: Shared) -> Result<()> {
    let mut client = None;
    let mut status = Status::default();
    let mut png = None;
    loop {
        let start = Instant::now();
        let artifact_error = artifacts(&root, &session, &mut status).err();
        publish(&shared, &status, &png)?;
        let result = (|| -> Result<()> {
            if client.is_none() {
                client = Some(McpClient::spawn(&executable, Duration::from_secs(20))?);
            }
            let client = client.as_mut().context("Read-only bridge unavailable")?;
            let state = client.tool(
                "ocs_read",
                json!({"ocs_session_id":session,"op":"state","parameters":{}}),
            )?;
            ensure!(
                state["session_id"].as_str() == Some(session.as_str()),
                "State session mismatch"
            );
            status.state = Some(state.clone());
            status.updated_unix = now();
            status.connected = true;
            status.error = None;
            publish(&shared, &status, &png)?;
            ensure!(
                state["document_id"].as_u64() == Some(DOCUMENT),
                "Active drawing is not document 2; capture withheld"
            );
            let bytes = capture(client, &session)?;
            png = Some(Arc::new(bytes));
            status.image_updated_unix = now();
            Ok(())
        })();
        match result {
            Ok(()) => status.error = artifact_error.map(|e| format!("Artifact progress: {e:#}")),
            Err(error) => {
                status.connected = false;
                status.error = Some(
                    format!("Read-only polling failed: {error:#}")
                        .chars()
                        .take(1024)
                        .collect(),
                );
                // Only state and current-view capture can be retried on a replacement bridge.
                client = None;
            }
        }
        publish(&shared, &status, &png)?;
        thread::sleep(INTERVAL.saturating_sub(start.elapsed()));
    }
}
struct Request {
    method: String,
    path: String,
}
fn request(stream: &mut TcpStream) -> std::result::Result<Request, u16> {
    let deadline = Instant::now() + HTTP_TIMEOUT;
    let mut bytes = Vec::new();
    loop {
        if bytes.len() == 8192 {
            return Err(431);
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|v| !v.is_zero())
            .ok_or(408u16)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| 400u16)?;
        let mut chunk = [0; 512];
        let limit = chunk.len().min(8192 - bytes.len());
        let count = stream.read(&mut chunk[..limit]).map_err(|_| 408u16)?;
        if count == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            if end + 4 != bytes.len() {
                return Err(400);
            }
            break;
        }
    }
    parse_request(&bytes)
}

fn parse_request(bytes: &[u8]) -> std::result::Result<Request, u16> {
    if bytes.len() > 8192 {
        return Err(431);
    }
    if !bytes.ends_with(b"\r\n\r\n")
        || bytes[..bytes.len().saturating_sub(4)]
            .windows(4)
            .any(|v| v == b"\r\n\r\n")
    {
        return Err(400);
    }
    if bytes
        .iter()
        .any(|&b| b < 32 && !matches!(b, b'\r' | b'\n' | b'\t'))
    {
        return Err(400);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| 400u16)?;
    let mut lines = text.split("\r\n");
    let parts: Vec<_> = lines.next().ok_or(400u16)?.split(' ').collect();
    if parts.len() != 3 || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
        return Err(400);
    }
    let mut host = None;
    let mut origin = None;
    for line in lines.filter(|v| !v.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(400);
        }
        let value = value.trim();
        if name.eq_ignore_ascii_case("host") {
            if host.replace(value).is_some() {
                return Err(400);
            }
        } else if name.eq_ignore_ascii_case("origin") {
            if origin.replace(value).is_some() {
                return Err(400);
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value != "0")
        {
            return Err(400);
        } else if name.eq_ignore_ascii_case("sec-fetch-site") && value == "cross-site" {
            return Err(403);
        }
    }
    if !matches!(host, Some("127.0.0.1:8770" | "localhost:8770")) {
        return Err(403);
    }
    if origin
        .is_some_and(|value| !matches!(value, "http://127.0.0.1:8770" | "http://localhost:8770"))
    {
        return Err(403);
    }
    if parts[0] != "GET" {
        return Err(405);
    }
    let path = parts[1].split('?').next().ok_or(400u16)?;
    Ok(Request {
        method: parts[0].to_owned(),
        path: path.to_owned(),
    })
}
fn write_deadline(stream: &mut TcpStream, mut bytes: &[u8], deadline: Instant) -> Result<()> {
    while !bytes.is_empty() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|v| !v.is_zero())
            .context("HTTP write deadline")?;
        stream.set_write_timeout(Some(remaining))?;
        let count = stream.write(bytes)?;
        ensure!(count > 0, "HTTP connection closed");
        bytes = &bytes[count..];
    }
    Ok(())
}
fn headers(
    stream: &mut TcpStream,
    code: u16,
    mime: &str,
    length: u64,
    attachment: bool,
    deadline: Instant,
) -> Result<()> {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        431 => "Request Header Fields Too Large",
        _ => "Service Unavailable",
    };
    let extra = if attachment {
        "Content-Disposition: attachment; filename=\"checkpoint-incomplete.dwg\"\r\n"
    } else if code == 405 {
        "Allow: GET\r\n"
    } else {
        ""
    };
    let header = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n{extra}\r\n");
    write_deadline(stream, header.as_bytes(), deadline)
}
fn respond(stream: &mut TcpStream, code: u16, mime: &str, body: &[u8]) -> Result<()> {
    let deadline = Instant::now() + HTTP_TIMEOUT;
    headers(stream, code, mime, body.len() as u64, false, deadline)?;
    write_deadline(stream, body, deadline)
}
fn serve(mut stream: TcpStream, root: &Path, shared: &Shared) -> Result<()> {
    stream.set_read_timeout(Some(HTTP_TIMEOUT))?;
    stream.set_write_timeout(Some(HTTP_TIMEOUT))?;
    let request = match request(&mut stream) {
        Ok(request) => request,
        Err(code) => {
            return respond(
                &mut stream,
                code,
                "text/plain; charset=utf-8",
                b"Request rejected\n",
            )
        }
    };
    ensure!(request.method == "GET", "Unsupported method");
    match request.path.as_str() {
        "/" => respond(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            include_str!("monitor.html").as_bytes(),
        ),
        "/api/status" => {
            let status = match shared.lock() {
                Ok(snapshot) => snapshot.status.clone(),
                Err(_) => {
                    return respond(&mut stream, 503, "text/plain", b"Snapshot unavailable\n")
                }
            };
            respond(
                &mut stream,
                200,
                "application/json",
                &serde_json::to_vec(&status)?,
            )
        }
        "/viewport.png" => {
            let png = shared.lock().ok().and_then(|snapshot| snapshot.png.clone());
            match png {
                Some(png) => respond(&mut stream, 200, "image/png", png.as_slice()),
                None => respond(
                    &mut stream,
                    503,
                    "text/plain",
                    b"No successful actual viewport capture yet\n",
                ),
            }
        }
        "/download/checkpoint" => {
            let file = match fixed_file(root, CHECKPOINT) {
                Ok(file) => file,
                Err(_) => {
                    return respond(&mut stream, 404, "text/plain", b"Checkpoint unavailable\n")
                }
            };
            let length = file.metadata()?.len();
            let deadline = Instant::now() + HTTP_TIMEOUT;
            headers(
                &mut stream,
                200,
                "application/octet-stream",
                length,
                true,
                deadline,
            )?;
            let mut file = file.take(length);
            let mut buffer = [0; 16384];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                write_deadline(&mut stream, &buffer[..count], deadline)?;
            }
            Ok(())
        }
        _ => respond(&mut stream, 404, "text/plain", b"Not found\n"),
    }
}
fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let root =
        fs::canonicalize(args.next().context(
            "usage: monitor <artifact-root>; OCS_EXECUTABLE and OCS_SESSION_ID required",
        )?)?;
    ensure!(
        root.is_dir() && args.next().is_none(),
        "Supply exactly one artifact directory"
    );
    let executable =
        fs::canonicalize(env::var_os("OCS_EXECUTABLE").context("OCS_EXECUTABLE required")?)?;
    ensure!(executable.is_file(), "OCS_EXECUTABLE is not a file");
    let session = env::var("OCS_SESSION_ID")
        .context("Explicit OCS_SESSION_ID required; monitor never launches a GUI")?;
    ensure!(
        !session.is_empty()
            && session.len() <= 128
            && session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid OCS_SESSION_ID"
    );
    let listener = TcpListener::bind("127.0.0.1:8770").context("Binding localhost monitor")?;
    let mut initial = Snapshot::default();
    initial.status.error = Some("Awaiting first actual read-only poll".into());
    if let Err(error) = artifacts(&root, &session, &mut initial.status) {
        initial.status.error = Some(format!("Artifact progress: {error:#}"));
    }
    let shared = Arc::new(Mutex::new(initial));
    let worker_shared = Arc::clone(&shared);
    let worker_root = root.clone();
    thread::Builder::new()
        .name("read-only-monitor".into())
        .spawn(move || {
            if poll(worker_root, executable, session, worker_shared).is_err() {
                eprintln!("Read-only monitor polling stopped: snapshot unavailable");
            }
        })?;
    println!(
        "Read-only monitor: http://127.0.0.1:8770 (document 2; no GUI launch or CAD mutations)"
    );
    for connection in listener.incoming() {
        match connection {
            Ok(stream) => {
                let _ = serve(stream, &root, &shared);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => bail!("Monitor accept failed: {error}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn http_requires_exact_loopback_host_and_same_origin_get() {
        for host in ["127.0.0.1:8770", "localhost:8770"] {
            let wire = format!(
                "GET /viewport.png?t=123 HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\n\r\n"
            );
            assert_eq!(
                parse_request(wire.as_bytes()).ok().map(|r| r.path),
                Some("/viewport.png".into())
            );
        }
        for wire in [
            "GET / HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: evil.test:8770\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:8770.evil.test\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:8770\r\nOrigin: null\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:8770\r\nOrigin: https://evil.test\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:8770\r\nSec-Fetch-Site: cross-site\r\n\r\n",
        ] {
            assert_eq!(parse_request(wire.as_bytes()).err(), Some(403));
        }
        assert_eq!(
            parse_request(b"POST / HTTP/1.1\r\nHost: localhost:8770\r\n\r\n").err(),
            Some(405)
        );
    }
    #[test]
    fn http_rejects_oversize_ambiguous_or_body_bearing_requests() {
        assert_eq!(parse_request(&[b'x'; 8193]).err(), Some(431));
        for wire in [
            "GET / HTTP/1.1\r\nHost: localhost:8770\r\nHost: localhost:8770\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:8770\r\nContent-Length: 1\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:8770\r\nTransfer-Encoding: chunked\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:8770\r\n\r\nGET / HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:8770\r\n\r\nbody",
        ] {
            assert_eq!(parse_request(wire.as_bytes()).err(), Some(400));
        }
    }
    #[test]
    fn progress_uses_receipts_not_preparation_or_checkpoint() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = fs::canonicalize(temp.path())?;
        fs::create_dir(root.join("actual"))?;
        fs::write(
            root.join("phases.json"),
            br#"[{"steps":[{}]},{"steps":[{},{}]}]"#,
        )?;
        for index in 0..2 {
            fs::write(
                root.join(format!("actual/phase-{index:03}-prepared.json")),
                b"{}",
            )?;
        }
        fs::write(
            root.join("actual/phase-000-result.json"),
            br#"{"ok":true,"failed_steps":0,"completed_steps":1,"status":"completed"}"#,
        )?;
        let p = progress(&root)?;
        assert_eq!((p.total, p.prepared, p.completed), (2, 2, 1));
        assert_eq!(p.unacknowledged, vec![2]);
        assert!(!final_delivery(&root, &p, "explicit-session"));
        for invalid in [
            json!({"ok":false,"failed_steps":0,"completed_steps":2}),
            json!({"ok":true,"failed_steps":1,"completed_steps":2}),
            json!({"ok":true,"failed_steps":0,"completed_steps":1}),
            json!({"ok":true,"failed_steps":0,"completed_steps":2,"status":"running"}),
            json!({"ok":true,"completed_steps":2}),
        ] {
            assert!(!acknowledged(&invalid, 2));
        }
        Ok(())
    }
}
