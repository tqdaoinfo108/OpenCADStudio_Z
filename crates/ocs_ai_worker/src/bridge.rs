//! Synchronous stdio MCP client and explicitly pinned desktop CAD session.
use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use uuid::Uuid;
const LEGACY_PROTOCOL: &str = "2025-11-25";
const MODERN_PROTOCOL: &str = "2026-07-28";
const MAX_LINE: usize = 32 * 1024 * 1024;
const MAX_REQUEST: usize = 1_048_576;
const MAX_RETAINED_REQUESTS: usize = 4096;
macro_rules! wire_enum {
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $wire)] $variant),+ }
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }
            pub fn from_name(name: &str) -> Option<Self> {
                match name { $($wire => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}
wire_enum!(ToolName {
    Sessions => "ocs_sessions", Read => "ocs_read", Execute => "ocs_execute",
    Capture => "ocs_capture", Inspect => "ocs_inspect", Query => "ocs_query",
    FindText => "ocs_find_text", Audit => "ocs_audit", Commands => "ocs_commands",
    Measure => "ocs_measure", Render => "ocs_render", Run => "ocs_run",
    New => "ocs_new", Open => "ocs_open", Save => "ocs_save",
    SaveVerified => "ocs_save_verified", Select => "ocs_select", Cancel => "ocs_cancel",
    Undo => "ocs_undo", Redo => "ocs_redo"
});
wire_enum!(ReadOp {
    State => "state", Hello => "hello", Query => "query", Records => "records",
    RecordSchema => "record_schema", Capabilities => "capabilities", Tools => "tools",
    Entities => "entities", Blocks => "blocks", Layers => "layers", Header => "header",
    Properties => "properties", Measure => "measure", Snap => "snap", Grips => "grips",
    History => "history", Commands => "commands", Events => "events", Operation => "operation",
    BatchResult => "batch_result", Guide => "guide", EntitySchema => "entity_schema",
    Validate => "validate", XdataGet => "xdata_get", Audit => "audit",
    TextSearch => "text_search", TextAudit => "text_audit", Keytips => "keytips", Capture => "capture"
});
wire_enum!(ExecuteOp {
    New => "new", Open => "open", Activate => "activate", SwitchDocument => "switch_document",
    Run => "run", Start => "start", Input => "input", Cancel => "cancel", Undo => "undo",
    Redo => "redo", Select => "select", Property => "property", GripDrag => "grip_drag",
    Click => "click", Pointer => "pointer", SetProperties => "set_properties", Action => "action",
    EmbedImage => "embed_image", Wblock => "wblock", Plot => "plot",
    EntitiesCreate => "entities_create", EntitiesDelete => "entities_delete",
    EntitiesTransform => "entities_transform", NodeGraph => "node_graph", TextReplace => "text_replace",
    BlockDefine => "block_define", BlockDelete => "block_delete", XdataSet => "xdata_set",
    ViewFocus => "view_focus", EntitiesCopyTo => "entities_copy_to", GroupCreate => "group_create",
    SelectionSetSave => "selection_set_save", SelectionSetLoad => "selection_set_load",
    UserSelect => "user_select", Getpoint => "getpoint", Close => "close", Sysvar => "sysvar",
    LayoutCreate => "layout_create", PageSetupSet => "page_setup_set", FileIdentity => "file_identity",
    Save => "save", SaveVerified => "save_verified", Stop => "stop", Batch => "batch"
});
#[derive(Debug)]
struct RpcFailure {
    code: i64,
    message: String,
}
impl std::fmt::Display for RpcFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MCP JSON-RPC error {}: {}", self.code, self.message)
    }
}
impl std::error::Error for RpcFailure {}
struct WriteJob {
    bytes: Vec<u8>,
    done: SyncSender<io::Result<()>>,
}
/// Owns only the `--mcp` bridge, never the attached or bridge-launched GUI.
/// Transport failures poison the client; there is deliberately no reconnect/replay.
pub struct McpClient {
    child: Child,
    outgoing: Option<SyncSender<WriteJob>>,
    incoming: Receiver<io::Result<Vec<u8>>>,
    workers: Vec<JoinHandle<()>>,
    timeout: Duration,
    serial: u64,
    modern: bool,
    tasks: bool,
    broken: bool,
    instance_id: Uuid,
}
impl McpClient {
    pub fn spawn(executable: &Path, timeout: Duration) -> Result<Self> {
        ensure!(!timeout.is_zero(), "MCP timeout must be positive");
        let mut command = Command::new(executable);
        command
            .arg("--mcp")
            .env_remove("OPENAI_API_KEY")
            .env_remove("OPENHANDS_AUTOMATION_API_KEY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().context("Starting MCP bridge")?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let (outgoing, writes) = mpsc::sync_channel::<WriteJob>(1);
        let (frames, incoming) = mpsc::sync_channel(4);
        let writer = thread::spawn(move || {
            let mut stdin = stdin;
            while let Ok(job) = writes.recv() {
                let result = stdin.write_all(&job.bytes).and_then(|()| stdin.flush());
                let failed = result.is_err();
                let _ = job.done.send(result);
                if failed {
                    break;
                }
            }
        });
        let reader = thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            loop {
                let frame = bounded_line(&mut stdout, MAX_LINE);
                let failed = frame.is_err();
                if frames.send(frame).is_err() || failed {
                    break;
                }
            }
        });
        let errors = thread::spawn(move || {
            // Stderr can contain paths, tokens and drawing data: drain, never retain or print.
            let _ = io::copy(&mut BufReader::new(stderr), &mut io::sink());
        });
        let mut client = Self {
            child,
            outgoing: Some(outgoing),
            incoming,
            workers: vec![writer, reader, errors],
            timeout,
            serial: 0,
            modern: false,
            tasks: false,
            broken: false,
            instance_id: Uuid::new_v4(),
        };
        let deadline = client.deadline()?;
        let initialized = client.rpc(
            "initialize",
            json!({
                "protocolVersion": LEGACY_PROTOCOL,
                "capabilities": {},
                "clientInfo": {"name":"ocs-ai-worker", "version":env!("CARGO_PKG_VERSION")}
            }),
            deadline,
        )?;
        ensure!(
            initialized["protocolVersion"].as_str() == Some(LEGACY_PROTOCOL),
            "Bridge negotiated an unsupported MCP protocol"
        );
        client.send(
            json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
            deadline,
        )?;
        // OCS supports discovery even on the initialized legacy channel. Never guess modern support.
        match client.rpc("server/discover", json!({}), deadline) {
            Ok(discovery) => {
                client.modern = discovery["supportedVersions"]
                    .as_array()
                    .is_some_and(|versions| {
                        versions.iter().any(|v| v.as_str() == Some(MODERN_PROTOCOL))
                    });
                client.tasks = client.modern
                    && discovery["capabilities"]["extensions"]["io.modelcontextprotocol/tasks"]
                        .is_object();
            }
            Err(error)
                if error
                    .downcast_ref::<RpcFailure>()
                    .is_some_and(|e| e.code == -32601) => {}
            Err(error) => return Err(error.context("Discovering MCP protocol")),
        }
        Ok(client)
    }
    /// Full tools/call result, including images, content, structuredContent and isError.
    /// Task polling shares a single deadline with the original call.
    pub fn call_tool(&mut self, name: &str, args: Value) -> Result<Value> {
        let deadline = self.deadline()?;
        self.call_tool_until(name, args, deadline)
    }
    fn call_tool_until(&mut self, name: &str, args: Value, deadline: Instant) -> Result<Value> {
        ensure!(args.is_object(), "Tool arguments must be an object");
        let mut result = self.rpc(
            "tools/call",
            json!({"name":name,"arguments":args}),
            deadline,
        )?;
        if result["resultType"].as_str() == Some("task") {
            ensure!(
                self.tasks,
                "Server returned a task without negotiated task support"
            );
            let task_id = result["taskId"]
                .as_str()
                .context("Missing taskId")?
                .to_owned();
            loop {
                let interval = result["pollIntervalMs"]
                    .as_u64()
                    .unwrap_or(250)
                    .clamp(10, 1000);
                self.pause(Duration::from_millis(interval), deadline)?;
                result = self.rpc("tasks/get", json!({"taskId":task_id}), deadline)?;
                if let Some(completed) = task_result(&result, &task_id)? {
                    result = completed;
                    break;
                }
            }
        }
        ensure!(
            result.is_object() && result["content"].is_array(),
            "Malformed MCP tools/call result"
        );
        Ok(result)
    }
    /// Structured tool JSON (or a legacy JSON text block), rejecting MCP and CAD refusals.
    pub fn tool(&mut self, name: &str, args: Value) -> Result<Value> {
        structured_result(&self.call_tool(name, args)?)
    }
    pub fn tool_named(&mut self, name: ToolName, args: Value) -> Result<Value> {
        self.tool(name.as_str(), args)
    }
    pub fn tools(&mut self) -> Result<Vec<Value>> {
        let deadline = self.deadline()?;
        let mut params = json!({});
        let mut tools = Vec::new();
        let mut cursors = HashSet::new();
        loop {
            let result = self.rpc("tools/list", params.clone(), deadline)?;
            let page = result["tools"]
                .as_array()
                .context("Missing MCP tools array")?;
            ensure!(tools.len() + page.len() <= 4096, "Too many MCP tools");
            tools.extend(page.iter().cloned());
            match result.get("nextCursor").filter(|v| !v.is_null()) {
                None => return Ok(tools),
                Some(cursor) => {
                    let cursor = cursor.as_str().context("Invalid tools cursor")?;
                    ensure!(cursors.insert(cursor.to_owned()), "Repeated tools cursor");
                    params["cursor"] = json!(cursor);
                }
            }
        }
    }
    fn deadline(&self) -> Result<Instant> {
        Instant::now()
            .checked_add(self.timeout)
            .context("MCP timeout is too large")
    }
    fn meta(&self) -> Value {
        let mut capabilities = json!({});
        if self.tasks {
            capabilities["extensions"] = json!({"io.modelcontextprotocol/tasks":{}});
        }
        json!({
            "io.modelcontextprotocol/protocolVersion":MODERN_PROTOCOL,
            "io.modelcontextprotocol/clientInfo":{"name":"ocs-ai-worker","version":env!("CARGO_PKG_VERSION")},
            "io.modelcontextprotocol/clientCapabilities":capabilities
        })
    }
    fn rpc(&mut self, method: &str, mut params: Value, deadline: Instant) -> Result<Value> {
        ensure!(
            !self.broken,
            "MCP transport is closed; outcome may be unknown; no automatic replay"
        );
        self.serial = self
            .serial
            .checked_add(1)
            .context("MCP request counter exhausted")?;
        let id = self.serial;
        if self.modern {
            params["_meta"] = self.meta();
        }
        self.send(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            deadline,
        )?;
        loop {
            let remaining = self.remaining(deadline)?;
            let frame = match self.incoming.recv_timeout(remaining) {
                Ok(Ok(frame)) => frame,
                Ok(Err(error)) => return self.fail(anyhow!(error).context("Reading MCP stdout")),
                Err(RecvTimeoutError::Timeout) => {
                    return self.fail(anyhow!("MCP response timed out; outcome unknown"))
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return self.fail(anyhow!("MCP stdout closed; outcome unknown"))
                }
            };
            let message: Value = match serde_json::from_slice(&frame) {
                Ok(value) => value,
                Err(_) => return self.fail(anyhow!("Invalid JSON on MCP stdout")),
            };
            if message["jsonrpc"].as_str() != Some("2.0") || !message.is_object() {
                return self.fail(anyhow!("Malformed JSON-RPC message"));
            }
            if let Some(server_method) = message.get("method") {
                if !server_method.is_string() {
                    return self.fail(anyhow!("Invalid server method"));
                }
                if let Some(server_id) = message.get("id") {
                    let response = if server_method == "ping" {
                        json!({"jsonrpc":"2.0","id":server_id,"result":{}})
                    } else {
                        json!({"jsonrpc":"2.0","id":server_id,"error":{"code":-32601,"message":"Client method not supported"}})
                    };
                    self.send(response, deadline)?;
                }
                continue;
            }
            if message["id"].as_u64() != Some(id) {
                return self.fail(anyhow!(
                    "Unexpected MCP response id; transport desynchronized"
                ));
            }
            if let Some(error) = message.get("error") {
                ensure!(
                    message.get("result").is_none(),
                    "RPC has both result and error"
                );
                return Err(RpcFailure {
                    code: error["code"].as_i64().unwrap_or(-32603),
                    message: error["message"]
                        .as_str()
                        .unwrap_or("Unspecified server error")
                        .chars()
                        .take(1024)
                        .collect(),
                }
                .into());
            }
            match message.get("result") {
                Some(value) => return Ok(value.clone()),
                None => return self.fail(anyhow!("MCP response has no result or error")),
            }
        }
    }
    fn send(&mut self, value: Value, deadline: Instant) -> Result<()> {
        ensure!(!self.broken, "MCP transport is closed");
        match self.child.try_wait() {
            Ok(Some(status)) => {
                return self.fail(anyhow!("MCP bridge exited ({status}); outcome unknown"))
            }
            Ok(None) => {}
            Err(error) => return self.fail(anyhow!(error).context("Checking MCP bridge")),
        }
        let mut bytes = serde_json::to_vec(&value)?;
        ensure!(
            bytes.len() < MAX_REQUEST,
            "MCP request exceeds server line limit"
        );
        bytes.push(b'\n');
        let (done, written) = mpsc::sync_channel(1);
        let remaining = self.remaining(deadline)?;
        if self
            .outgoing
            .as_ref()
            .context("MCP writer closed")?
            .try_send(WriteJob { bytes, done })
            .is_err()
        {
            return self.fail(anyhow!("MCP writer stopped or blocked; outcome unknown"));
        }
        match written.recv_timeout(remaining) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                self.fail(anyhow!(error).context("Writing MCP request; outcome unknown"))
            }
            Err(_) => self.fail(anyhow!(
                "MCP write timed out or writer exited; outcome unknown"
            )),
        }
    }
    fn remaining(&mut self, deadline: Instant) -> Result<Duration> {
        match deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
        {
            Some(remaining) => Ok(remaining),
            None => self.fail(anyhow!(
                "MCP deadline exceeded; outcome unknown; no automatic replay"
            )),
        }
    }
    fn pause(&mut self, delay: Duration, deadline: Instant) -> Result<()> {
        let remaining = self.remaining(deadline)?;
        thread::sleep(delay.min(remaining));
        self.remaining(deadline)?;
        Ok(())
    }
    fn fail<T>(&mut self, error: anyhow::Error) -> Result<T> {
        self.shutdown();
        Err(error)
    }
    fn shutdown(&mut self) {
        self.broken = true;
        self.outgoing.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for McpClient {
    fn drop(&mut self) {
        self.shutdown();
        // A descendant could retain an inherited pipe. Never block Drop joining its reader.
        for worker in self.workers.drain(..) {
            if worker.is_finished() {
                let _ = worker.join();
            }
        }
    }
}
fn bounded_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "MCP stdout ended before a complete line",
            ));
        }
        let count = chunk
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(chunk.len(), |pos| pos + 1);
        if line.len().saturating_add(count) > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "MCP response exceeds line limit",
            ));
        }
        let complete = chunk[count - 1] == b'\n';
        line.extend_from_slice(&chunk[..count]);
        reader.consume(count);
        if complete {
            return Ok(line);
        }
    }
}
fn short_value(value: &Value) -> String {
    value.to_string().chars().take(1024).collect()
}
fn check_refusal(value: &Value) -> Result<()> {
    ensure!(
        value["ok"].as_bool() != Some(false)
            && !matches!(value["status"].as_str(), Some("failed" | "cancelled")),
        "CAD refused request: {}",
        short_value(value)
    );
    Ok(())
}
fn structured_result(result: &Value) -> Result<Value> {
    ensure!(
        result["isError"].as_bool() != Some(true),
        "MCP tool refused request: {}",
        short_value(&result["content"])
    );
    let value = raw_structured_result(result)?;
    check_refusal(&value)?;
    Ok(value)
}
fn raw_structured_result(result: &Value) -> Result<Value> {
    if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
        ensure!(
            structured.is_object(),
            "MCP structuredContent must be an object"
        );
        return Ok(structured.clone());
    }
    let content = result["content"]
        .as_array()
        .context("Missing MCP tool content")?;
    let mut parsed = None;
    for block in content {
        if block["type"] == "text" {
            if let Some(value) = block["text"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
            {
                ensure!(parsed.is_none(), "Ambiguous multiple JSON text blocks");
                parsed = Some(if value.is_object() {
                    value
                } else {
                    json!({"result":value})
                });
            }
        }
    }
    parsed.context("Tool returned no structured JSON")
}
fn audit_result(full: &Value) -> Result<Value> {
    let report = raw_structured_result(full)?;
    // OCS marks a negative audit isError and omits structuredContent; it is still a report.
    ensure!(
        report["ok"].is_boolean()
            && report["summary"].is_object()
            && report["issues"].is_array()
            && report["target"].is_object()
            && report.get("code").is_none_or(Value::is_null)
            && report.get("error").is_none_or(Value::is_null)
            && report
                .get("status")
                .is_none_or(|s| matches!(s.as_str(), Some("passed" | "warning" | "failed"))),
        "Audit tool refused request or returned a malformed report: {}",
        short_value(&report)
    );
    Ok(report)
}

struct Mutation {
    original: Value,
    envelope: Value,
    client: Uuid,
    result: Option<Value>,
}
impl Mutation {
    fn check_retry(&self, original: &Value, client: Uuid) -> Result<Option<Value>> {
        ensure!(
            &self.original == original,
            "request_id was already used with different arguments"
        );
        ensure!(
            self.client == client,
            "Refusing mutation replay on a replacement bridge; inspect operation first"
        );
        Ok(self.result.clone())
    }
}
/// Pins one editor session and document. Connect never creates, opens, closes or saves a drawing.
/// Completed mutation results and exact envelopes are retained (up to 4096 distinct IDs).
pub struct CadSession {
    pub client: McpClient,
    pub session_id: String,
    pub document_id: Option<u64>,
    pub revision: Option<u64>,
    pinned_session_id: String,
    pinned_document: Option<u64>,
    client_id: String,
    mutations: HashMap<String, Mutation>,
}
impl CadSession {
    pub fn connect(executable: &Path, timeout: Duration, session_id: Option<&str>) -> Result<Self> {
        let mut client = McpClient::spawn(executable, timeout)?;
        let mut listed =
            session_list(&client.tool("ocs_sessions", json!({"launch_if_none":false}))?)?;
        let launched = listed.is_empty() && session_id.is_none();
        if launched {
            listed = session_list(&client.tool("ocs_sessions", json!({"launch_if_none":true}))?)?;
        }
        let chosen = choose_session(&listed, session_id)?;
        let id = chosen["session_id"]
            .as_str()
            .context("Session has no id")?
            .to_owned();
        let mut session = Self {
            client,
            session_id: id.clone(),
            pinned_session_id: id,
            document_id: None,
            revision: None,
            pinned_document: None,
            client_id: Uuid::new_v4().to_string(),
            mutations: HashMap::new(),
        };
        session.observe(&chosen)?;
        let state = session.read("state", json!({}))?;
        session.observe(&state)?;
        if launched {
            for _ in 0..2 {
                let state = session.read("state", json!({}))?;
                if !known_startup_modal(&state) {
                    break;
                }
                session.execute_with_options(
                    json!({"op":"action","name":"close_modal"}),
                    &Uuid::new_v4().to_string(),
                    json!({}),
                    true,
                )?;
            }
        }
        Ok(session)
    }
    pub fn read(&mut self, op: &str, parameters: Value) -> Result<Value> {
        let deadline = self.client.deadline()?;
        self.read_until(op, parameters, deadline)
    }
    /// Returns genuine technical audit failures for QA/self-healing, not transport/tool refusals.
    pub fn audit(&mut self, parameters: Value) -> Result<Value> {
        self.ensure_active()?;
        let mut parameters = object(parameters, "Audit parameters")?;
        let document = self.document_id.context("No active audit document")?;
        if let Some(id) = parameters.get("document_id") {
            ensure!(
                id.as_u64() == Some(document),
                "Audit cannot change the pinned document"
            );
        }
        parameters.insert("document_id".into(), json!(document));
        let full = self.client.call_tool(
            "ocs_read",
            json!({
                "ocs_session_id":self.session_id,"op":"audit","parameters":parameters
            }),
        )?;
        let report = audit_result(&full)?;
        if let Some(id) = report.get("document_id") {
            ensure!(
                id.as_u64() == Some(document),
                "Audit returned a different document"
            );
        }
        Ok(report)
    }
    pub fn read_op(&mut self, op: ReadOp, parameters: Value) -> Result<Value> {
        self.read(op.as_str(), parameters)
    }
    fn read_until(&mut self, op: &str, parameters: Value, deadline: Instant) -> Result<Value> {
        self.check_pin()?;
        ensure!(
            ReadOp::from_name(op).is_some(),
            "Unknown MCP read operation: {op}"
        );
        let mut parameters = object(parameters, "Read parameters")?;
        if !matches!(
            op,
            "state"
                | "hello"
                | "capabilities"
                | "tools"
                | "guide"
                | "entity_schema"
                | "validate"
                | "operation"
                | "batch_result"
                | "events"
        ) {
            if let Some(id) = self.pinned_document {
                parameters.entry("document_id").or_insert(json!(id));
            }
        }
        let full = self.client.call_tool_until(
            "ocs_read",
            json!({
                "ocs_session_id":self.session_id,"op":op,"parameters":parameters
            }),
            deadline,
        )?;
        let result = structured_result(&full)?;
        if matches!(op, "state" | "hello") {
            self.observe(&result)?;
        }
        Ok(result)
    }
    /// No retries are implicit. Reusing an ID with the same request returns its cached outcome
    /// or sends the identical retained envelope on the same bridge, never on a replacement client.
    pub fn execute(&mut self, request: Value, request_id: &str) -> Result<Value> {
        self.execute_with_options(
            request,
            request_id,
            json!({"response_detail":"summary"}),
            false,
        )
    }
    pub fn execute_op(
        &mut self,
        op: ExecuteOp,
        parameters: Value,
        request_id: &str,
    ) -> Result<Value> {
        let mut request = object(parameters, "Execute parameters")?;
        ensure!(
            !request.contains_key("op"),
            "Execute parameters must not override op"
        );
        request.insert("op".into(), json!(op.as_str()));
        self.execute(Value::Object(request), request_id)
    }
    fn execute_with_options(
        &mut self,
        request: Value,
        request_id: &str,
        options: Value,
        startup_only: bool,
    ) -> Result<Value> {
        self.check_pin()?;
        ensure!(
            !request_id.is_empty() && request_id.len() <= 128,
            "request_id must contain 1..128 bytes"
        );
        let mut input = object(request, "Execute request")?;
        if let Some(id) = input.get("request_id") {
            ensure!(id.as_str() == Some(request_id), "Conflicting request_id");
        }
        input.insert("request_id".into(), json!(request_id));
        let original = json!({"request":input,"options":options});
        let deadline = self.client.deadline()?;
        let envelope = if let Some(retained) = self.mutations.get(request_id) {
            if let Some(result) = retained.check_retry(&original, self.client.instance_id)? {
                return Ok(result);
            }
            retained.envelope.clone()
        } else {
            ensure!(
                self.mutations.len() < MAX_RETAINED_REQUESTS,
                "Mutation retention limit reached; start an explicitly new session wrapper"
            );
            let previous_document = self.pinned_document;
            let state = self.read_until("state", json!({}), deadline)?;
            if startup_only {
                ensure!(
                    known_startup_modal(&state),
                    "Startup modal changed; refusing to dismiss another dialog"
                );
            }
            let envelope = prepare_envelope(input, &state, previous_document, &self.client_id)?;
            self.mutations.insert(
                request_id.to_owned(),
                Mutation {
                    original,
                    envelope: envelope.clone(),
                    client: self.client.instance_id,
                    result: None,
                },
            );
            envelope
        };
        let arguments = execute_arguments(&self.session_id, &envelope, options)?;
        let full = self.client.call_tool_until("ocs_execute", arguments.clone(), deadline)
            .with_context(|| format!("Mutation {request_id}: outcome may be unknown; inspect operation, never replay with a new id"))?;
        let mut result = structured_result(&full)?;
        // Legacy batches live in the MCP bridge, not the GUI operation cache.
        while matches!(result["status"].as_str(), Some("accepted" | "running")) {
            self.client.pause(Duration::from_millis(100), deadline)?;
            result = if envelope["op"] == "batch" {
                structured_result(&self.client.call_tool_until(
                    "ocs_execute",
                    arguments.clone(),
                    deadline,
                )?)?
            } else {
                self.read_until("operation", json!({"request_id":request_id}), deadline)?
            };
        }
        if let Some(state) = result.get("state") {
            self.observe(state)?;
        }
        if matches!(
            envelope["op"].as_str(),
            Some("new" | "open" | "activate" | "switch_document" | "close")
        ) {
            let state = self.read_until("state", json!({}), deadline)?;
            self.observe(&state)?;
            self.pinned_document = self.document_id;
        }
        if let Some(retained) = self.mutations.get_mut(request_id) {
            retained.result = Some(result.clone());
        }
        Ok(result)
    }
    pub fn intent(&mut self, name: &str, args: Value) -> Result<Value> {
        self.check_pin()?;
        let mut args = object(args, "Intent arguments")?;
        if let Some(id) = args.remove("ocs_session_id") {
            ensure!(
                id.as_str() == Some(self.session_id.as_str()),
                "Intent cannot change pinned session"
            );
        }
        let read = match name {
            "ocs_inspect" => Some("state"),
            "ocs_query" => Some("query"),
            "ocs_find_text" => Some("text_search"),
            "ocs_audit" => Some("audit"),
            "ocs_commands" => Some("commands"),
            "ocs_measure" => Some("measure"),
            _ => None,
        };
        if let Some(op) = read {
            return self.read(op, Value::Object(args));
        }
        if name == "ocs_render" {
            self.ensure_active()?;
            args.insert("ocs_session_id".into(), json!(self.session_id));
            return self.client.tool("ocs_render", Value::Object(args));
        }
        let op = match name {
            "ocs_run" => "run",
            "ocs_new" => "new",
            "ocs_open" => "open",
            "ocs_save" => "save",
            "ocs_save_verified" => "save_verified",
            "ocs_select" => "select",
            "ocs_cancel" => "cancel",
            "ocs_undo" => "undo",
            "ocs_redo" => "redo",
            _ => bail!("Unknown intent tool: {name}"),
        };
        let request_id = match args.remove("request_id") {
            Some(value) => value
                .as_str()
                .context("request_id must be a string")?
                .to_owned(),
            None => Uuid::new_v4().to_string(),
        };
        let mut options = Map::new();
        for key in ["wait_seconds", "response_detail"] {
            if let Some(value) = args.remove(key) {
                options.insert(key.into(), value);
            }
        }
        if op == "run" {
            if let Some(command) = args.remove("command") {
                ensure!(
                    !args.contains_key("cmd"),
                    "Specify command, not both command and cmd"
                );
                args.insert("cmd".into(), command);
            }
        }
        ensure!(
            !args.contains_key("op"),
            "Intent must not override operation"
        );
        args.insert("op".into(), json!(op));
        self.execute_with_options(
            Value::Object(args),
            &request_id,
            Value::Object(options),
            false,
        )
        .with_context(|| format!("Intent {name}, request_id {request_id}"))
    }
    pub fn intent_named(&mut self, name: ToolName, args: Value) -> Result<Value> {
        self.intent(name.as_str(), args)
    }
    pub fn render_png(&mut self, max_dimension: u32) -> Result<Vec<u8>> {
        ensure!(
            (256..=4096).contains(&max_dimension),
            "max_dimension must be 256..4096"
        );
        self.ensure_active()?;
        let full = self.client.call_tool(
            "ocs_render",
            json!({
                "ocs_session_id":self.session_id,"max_dimension":max_dimension,
                "scope":"viewport","delivery":"inline"
            }),
        )?;
        decode_png(&full, max_dimension)
    }
    fn check_pin(&self) -> Result<()> {
        ensure!(
            self.session_id == self.pinned_session_id,
            "session_id is pinned; reconnect explicitly to change sessions"
        );
        Ok(())
    }
    fn ensure_active(&mut self) -> Result<()> {
        let pinned = self.pinned_document;
        let state = self.read("state", json!({}))?;
        ensure!(
            pinned.is_none() || state["document_id"].as_u64() == pinned,
            "Active document changed; refusing capture of another drawing"
        );
        Ok(())
    }
    fn observe(&mut self, state: &Value) -> Result<()> {
        if let Some(id) = state.get("session_id").and_then(Value::as_str) {
            ensure!(
                id == self.pinned_session_id,
                "Server returned a different session"
            );
        }
        if let Some(id) = state.get("document_id").and_then(Value::as_u64) {
            self.document_id = Some(id);
            if self.pinned_document.is_none() {
                self.pinned_document = Some(id);
            }
        }
        if let Some(revision) = state.get("revision").and_then(Value::as_u64) {
            self.revision = Some(revision);
        }
        Ok(())
    }
}
fn object(value: Value, description: &str) -> Result<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .with_context(|| format!("{description} must be an object"))
}
fn session_list(value: &Value) -> Result<Vec<Value>> {
    value["result"]
        .as_array()
        .cloned()
        .context("ocs_sessions returned no result array")
}
fn choose_session(sessions: &[Value], requested: Option<&str>) -> Result<Value> {
    let matching: Vec<_> = sessions
        .iter()
        .filter(|session| requested.is_none_or(|id| session["session_id"].as_str() == Some(id)))
        .collect();
    ensure!(
        matching.len() == 1,
        "Expected exactly one matching CAD session, found {}; supply an explicit live session_id",
        matching.len()
    );
    let chosen = matching[0];
    ensure!(
        chosen["session_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "Invalid session_id"
    );
    check_refusal(chosen)?;
    Ok(chosen.clone())
}
fn decode_png(full: &Value, max_dimension: u32) -> Result<Vec<u8>> {
    let metadata = structured_result(full)?;
    let content = full["content"]
        .as_array()
        .context("Capture content missing")?;
    let mut images = content
        .iter()
        .filter(|block| block["type"] == "image" && block["mimeType"] == "image/png");
    let image = images.next().context("Capture returned no inline PNG")?;
    ensure!(images.next().is_none(), "Capture returned multiple PNGs");
    let bytes = BASE64
        .decode(
            image["data"]
                .as_str()
                .context("Capture image data missing")?,
        )
        .context("Invalid PNG base64")?;
    ensure!(
        bytes.len() >= 33
            && &bytes[..8] == b"\x89PNG\r\n\x1a\n"
            && bytes[8..12] == 13u32.to_be_bytes()
            && &bytes[12..16] == b"IHDR",
        "Invalid PNG header"
    );
    let width = u32::from_be_bytes(bytes[16..20].try_into()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into()?);
    ensure!(
        width > 0 && height > 0 && width <= max_dimension && height <= max_dimension,
        "PNG dimensions exceed requested bound"
    );
    if let Some(length) = metadata.get("bytes") {
        ensure!(
            length.as_u64() == Some(bytes.len() as u64),
            "PNG byte count mismatch"
        );
    }
    if let Some(hash) = metadata.get("hash") {
        let digest = format!("{:x}", Sha256::digest(&bytes));
        ensure!(
            hash.as_str() == Some(digest.as_str()),
            "PNG SHA-256 mismatch"
        );
    }
    Ok(bytes)
}

fn task_result(task: &Value, task_id: &str) -> Result<Option<Value>> {
    ensure!(
        task["taskId"].as_str() == Some(task_id),
        "Task identity changed"
    );
    match task["status"].as_str() {
        Some("completed") => Ok(Some(
            task.get("result")
                .cloned()
                .context("Completed task has no result")?,
        )),
        Some("failed" | "cancelled") => bail!(
            "MCP task ended {}: {}",
            task["status"],
            short_value(&task["error"])
        ),
        Some("working" | "input_required") => Ok(None),
        _ => bail!("Invalid MCP task status"),
    }
}
fn known_startup_modal(state: &Value) -> bool {
    matches!(
        state["modal"].as_str(),
        Some("AssocPrompt" | "DonationPrompt")
    )
}

fn execute_arguments(session_id: &str, envelope: &Value, options: Value) -> Result<Value> {
    let mut arguments = object(options, "Execute options")?;
    arguments.insert("ocs_session_id".into(), json!(session_id));
    arguments.insert("request".into(), envelope.clone());
    arguments.entry("wait_seconds").or_insert(json!(0));
    arguments
        .entry("response_detail")
        .or_insert(json!("summary"));
    Ok(Value::Object(arguments))
}
fn prepare_envelope(
    mut input: Map<String, Value>,
    state: &Value,
    previous_document: Option<u64>,
    client_id: &str,
) -> Result<Value> {
    let op = input
        .get("op")
        .and_then(Value::as_str)
        .context("Missing execute op")?
        .to_owned();
    ensure!(
        ExecuteOp::from_name(&op).is_some(),
        "Unknown execute operation: {op}"
    );
    let document = state["document_id"]
        .as_u64()
        .context("State has no document_id")?;
    let revision = state["revision"]
        .as_u64()
        .context("State has no revision")?;
    let deliberate_switch = matches!(op.as_str(), "new" | "open" | "activate" | "switch_document");
    ensure!(deliberate_switch || previous_document.is_none() || previous_document == Some(document),
        "Active document changed; refusing mutation of another drawing (use deliberate new/open/activate)");
    if matches!(
        op.as_str(),
        "activate" | "switch_document" | "entities_copy_to"
    ) {
        ensure!(
            input.get("document_id").and_then(Value::as_u64).is_some(),
            "{op} requires explicit target document_id"
        );
    } else {
        if let Some(id) = input.get("document_id") {
            ensure!(
                id.as_u64() == Some(document),
                "Mutation document_id differs from active document"
            );
        }
        input.entry("document_id").or_insert(json!(document));
    }
    if let Some(revision) = input.get("revision") {
        ensure!(
            revision.as_u64().is_some(),
            "revision must be an unsigned integer"
        );
    }
    input.entry("revision").or_insert(json!(revision));
    input.entry("client_id").or_insert(json!(client_id));
    if matches!(
        op.as_str(),
        "input" | "property" | "run" | "action" | "save" | "save_verified" | "undo" | "redo"
    ) {
        input
            .entry("selection")
            .or_insert_with(|| state["selection"].clone());
    }
    Ok(Value::Object(input))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn constant_names(source: &str, name: &str) -> HashSet<String> {
        source
            .split_once(&format!("const {name}:"))
            .unwrap()
            .1
            .split_once("&[")
            .unwrap()
            .1
            .split_once("];")
            .unwrap()
            .0
            .split('"')
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .map(|(_, name)| name.to_owned())
            .collect()
    }
    #[test]
    fn operation_names_match_actual_server_catalogues() {
        let source = include_str!("../../../src/mcp.rs");
        let reads: HashSet<_> = ReadOp::ALL
            .iter()
            .map(|op| op.as_str().to_owned())
            .collect();
        let executes: HashSet<_> = ExecuteOp::ALL
            .iter()
            .map(|op| op.as_str().to_owned())
            .collect();
        assert_eq!(reads, constant_names(source, "READ_OPS"));
        assert_eq!(executes, constant_names(source, "EXECUTE_OPS"));
        assert_eq!(executes.len(), 44);
    }
    #[test]
    fn all_twenty_tools_match_actual_intents_and_facades() {
        let source = include_str!("../../../src/mcp.rs");
        let intents = include_str!("../../../src/mcp_intent.rs")
            .split_once("pub fn find_descriptor")
            .unwrap()
            .0;
        let mut expected = constant_names(source, "FACADE_TOOL_NAMES");
        expected.extend(
            intents
                .split('"')
                .filter(|name| {
                    name.starts_with("ocs_")
                        && name.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_')
                })
                .map(str::to_owned),
        );
        let names: HashSet<_> = ToolName::ALL
            .iter()
            .map(|tool| tool.as_str().to_owned())
            .collect();
        assert_eq!(names, expected);
        assert_eq!(names.len(), 20);
        for tool in ToolName::ALL {
            assert_eq!(ToolName::from_name(tool.as_str()), Some(*tool));
            assert_eq!(serde_json::to_value(tool).unwrap(), json!(tool.as_str()));
            assert_eq!(
                serde_json::from_value::<ToolName>(json!(tool.as_str())).unwrap(),
                *tool
            );
        }
        assert_eq!(ToolName::from_name("ocs_unknown"), None);
    }
    #[test]
    fn bounded_reader_handles_crlf_and_multiple_frames() {
        let mut input = BufReader::with_capacity(3, Cursor::new(b"{}\r\n{\"id\":2}\n"));
        assert_eq!(bounded_line(&mut input, 4).unwrap(), b"{}\r\n");
        assert_eq!(bounded_line(&mut input, 20).unwrap(), b"{\"id\":2}\n");
        assert_eq!(
            bounded_line(&mut input, 20).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    #[test]
    fn bounded_reader_refuses_oversized_and_truncated_lines() {
        let mut long = BufReader::with_capacity(2, Cursor::new(b"123456789\n"));
        assert_eq!(
            bounded_line(&mut long, 5).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(bounded_line(&mut Cursor::new(b"{}"), 20).is_err());
        assert!(bounded_line(&mut Cursor::new(b"1234\n"), 4).is_err());
    }
    #[test]
    fn structured_json_and_legacy_text_are_parsed_without_unwrapping_cad_result() {
        let cad = json!({"ok":true,"status":"completed","result":{"handles":["6F"]},"state":{"revision":4}});
        let full = json!({"content":[{"type":"text","text":cad.to_string()}],"structuredContent":cad,"isError":false});
        assert_eq!(structured_result(&full).unwrap(), cad);
        let legacy = json!({"content":[{"type":"text","text":cad.to_string()}],"isError":false});
        assert_eq!(structured_result(&legacy).unwrap(), cad);
        let sessions = json!({"content":[{"type":"text","text":"[{\"session_id\":\"s\"}]"}]});
        assert_eq!(
            structured_result(&sessions).unwrap()["result"][0]["session_id"],
            "s"
        );
    }
    #[test]
    fn refuses_mcp_and_cad_failures_and_ambiguous_text() {
        assert!(structured_result(
            &json!({"isError":true,"content":[{"type":"text","text":"bad"}]})
        )
        .is_err());
        assert!(
            structured_result(&json!({"structuredContent":{"ok":false,"code":"stale_state"}}))
                .is_err()
        );
        assert!(structured_result(&json!({"structuredContent":{"status":"cancelled"}})).is_err());
        assert!(
            structured_result(&json!({"content":[{"type":"text","text":"{\"ok\":false}"}]}))
                .is_err()
        );
        assert!(structured_result(
            &json!({"content":[{"type":"text","text":"{}"},{"type":"text","text":"{}"}]})
        )
        .is_err());
        assert!(structured_result(&json!({"content":[]})).is_err());
    }
    #[test]
    fn session_selection_never_chooses_first_of_multiple_sessions() {
        let sessions = vec![
            json!({"session_id":"a","ok":true}),
            json!({"session_id":"b","ok":true}),
        ];
        assert!(choose_session(&sessions, None).is_err());
        assert_eq!(choose_session(&sessions, Some("b")).unwrap(), sessions[1]);
        assert!(choose_session(&sessions, Some("missing")).is_err());
        assert!(choose_session(&[], None).is_err());
        assert!(choose_session(&[sessions[0].clone(), sessions[0].clone()], Some("a")).is_err());
    }
    #[test]
    fn execute_defaults_to_summary_and_preserves_explicit_intent_override() {
        let request = json!({"op":"batch","request_id":"large-batch","steps":[{"op":"undo"}]});
        let arguments = execute_arguments("session", &request, json!({})).unwrap();
        assert_eq!(arguments["response_detail"], "summary");
        assert_eq!(arguments["wait_seconds"], 0);
        assert_eq!(arguments["request"], request);
        let full = execute_arguments(
            "session",
            &request,
            json!({"response_detail":"full","wait_seconds":5}),
        )
        .unwrap();
        assert_eq!(full["response_detail"], "full");
        assert_eq!(full["wait_seconds"], 5);
        assert_eq!(full["request"], request);
    }
    #[test]
    fn mutation_envelope_uses_fresh_state_and_preserves_explicit_preconditions() {
        let state = json!({"document_id":7,"revision":23,"selection":["2A"]});
        let request = json!({"op":"run","cmd":"LINE 0,0 10,0","request_id":"draw-1"});
        let envelope = prepare_envelope(
            object(request.clone(), "request").unwrap(),
            &state,
            Some(7),
            "client-a",
        )
        .unwrap();
        assert_eq!(envelope["request_id"], "draw-1");
        assert_eq!(envelope["document_id"], 7);
        assert_eq!(envelope["revision"], 23);
        assert_eq!(envelope["client_id"], "client-a");
        assert_eq!(envelope["selection"], json!(["2A"]));
        let mut explicit = request;
        explicit["revision"] = json!(19);
        explicit["selection"] = json!([]);
        let envelope = prepare_envelope(
            object(explicit, "request").unwrap(),
            &state,
            Some(7),
            "client-a",
        )
        .unwrap();
        assert_eq!(envelope["revision"], 19);
        assert_eq!(envelope["selection"], json!([]));
    }
    #[test]
    fn mutation_envelope_refuses_document_drift_and_implicit_target_selection() {
        let state = json!({"document_id":8,"revision":23,"selection":[]});
        let run = object(json!({"op":"run","cmd":"ERASE"}), "request").unwrap();
        assert!(prepare_envelope(run, &state, Some(7), "client").is_err());
        for op in ["new", "open"] {
            let request = object(json!({"op":op}), "request").unwrap();
            assert!(prepare_envelope(request, &state, Some(7), "client").is_ok());
        }
        for op in ["activate", "switch_document", "entities_copy_to"] {
            let request = object(json!({"op":op}), "request").unwrap();
            assert!(prepare_envelope(request, &state, Some(8), "client").is_err());
            let request = object(json!({"op":op,"document_id":99}), "request").unwrap();
            assert_eq!(
                prepare_envelope(request, &state, Some(8), "client").unwrap()["document_id"],
                99
            );
        }
        assert!(prepare_envelope(
            object(json!({"op":"undo","document_id":99}), "request").unwrap(),
            &state,
            Some(8),
            "client"
        )
        .is_err());
        assert!(prepare_envelope(
            object(json!({"op":"undo"}), "request").unwrap(),
            &json!({"document_id":8}),
            Some(8),
            "client"
        )
        .is_err());
    }
    #[test]
    fn capture_decodes_real_png_content_and_checks_integrity_and_bounds() {
        // A complete 1x1 PNG, not a synthesized header or a transport stand-in.
        let data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfoAAAAASUVORK5CYII=";
        let bytes = BASE64.decode(data).unwrap();
        let mut full = json!({"content":[{"type":"image","mimeType":"image/png","data":data}],
            "structuredContent":{"bytes":bytes.len(),"hash":format!("{:x}",Sha256::digest(&bytes))},"isError":false});
        assert_eq!(decode_png(&full, 256).unwrap(), bytes);
        assert!(decode_png(&full, 0).is_err());
        full["structuredContent"]["hash"] = json!("incorrect");
        assert!(decode_png(&full, 256).is_err());
        full["structuredContent"]
            .as_object_mut()
            .unwrap()
            .remove("hash");
        full["structuredContent"]["bytes"] = json!(1);
        assert!(decode_png(&full, 256).is_err());
        full["content"][0]["data"] = json!("not base64");
        assert!(decode_png(&full, 256).is_err());
    }
    #[test]
    fn actual_task_envelope_returns_full_mcp_result_only_when_completed() {
        let full = json!({"content":[{"type":"text","text":"{\"ok\":true}"}],
            "structuredContent":{"ok":true,"status":"waiting_input"},"isError":false});
        assert!(task_result(&json!({"taskId":"t","status":"working"}), "t")
            .unwrap()
            .is_none());
        assert_eq!(
            task_result(
                &json!({"taskId":"t","status":"completed","result":full}),
                "t"
            )
            .unwrap(),
            Some(full)
        );
        for status in ["failed", "cancelled", "unknown"] {
            assert!(task_result(&json!({"taskId":"t","status":status}), "t").is_err());
        }
        assert!(task_result(&json!({"taskId":"t","status":"completed"}), "t").is_err());
        assert!(task_result(&json!({"taskId":"different","status":"working"}), "t").is_err());
    }
    #[test]
    fn retry_retains_identical_envelope_and_rejects_replacement_bridge() {
        let client = Uuid::new_v4();
        let original = json!({"request":{"op":"undo","request_id":"undo-1"},"options":{}});
        let envelope = json!({"op":"undo","request_id":"undo-1","document_id":7,"revision":12,
            "client_id":"client-a","selection":["6F"]});
        let mut mutation = Mutation {
            original: original.clone(),
            envelope: envelope.clone(),
            client,
            result: None,
        };
        assert!(mutation.check_retry(&original, client).unwrap().is_none());
        let completed =
            json!({"ok":true,"status":"completed","state":{"document_id":7,"revision":13}});
        mutation.result = Some(completed.clone());
        assert_eq!(
            mutation.check_retry(&original, client).unwrap(),
            Some(completed)
        );
        assert_eq!(mutation.envelope, envelope);
        assert!(mutation.check_retry(&original, Uuid::new_v4()).is_err());
        let mut changed = original.clone();
        changed["request"]["revision"] = json!(13);
        assert!(mutation.check_retry(&changed, client).is_err());
    }
    #[test]
    fn only_known_association_and_donation_startup_modals_are_dismissible() {
        for modal in ["AssocPrompt", "DonationPrompt"] {
            assert!(known_startup_modal(&json!({"modal":modal})));
        }
        for modal in [
            Value::Null,
            json!("SaveChanges"),
            json!("GpuWarning"),
            json!("BlockEditChanges"),
            json!({"name":"AssocPrompt"}),
        ] {
            assert!(!known_startup_modal(&json!({"modal":modal})));
        }
    }
    #[test]
    fn audit_returns_negative_report_but_not_protocol_or_tool_refusals() {
        let report = json!({"ok":false,"status":"failed","document_id":7,
            "summary":{"errors":1,"warnings":0},"issues":[{"severity":"error","code":"non_finite_geometry"}],
            "target":{"format":"dwg","version":"R2018","lossless":false}});
        let full = json!({"isError":true,"content":[{"type":"text","text":report.to_string()}]});
        assert_eq!(audit_result(&full).unwrap(), report);
        assert!(structured_result(&full).is_err());
        let structured = json!({"structuredContent":report,"content":[],"isError":false});
        assert_eq!(audit_result(&structured).unwrap(), report);
        for value in [
            json!({"ok":false,"code":"document_not_active","error":"activate first"}),
            json!({"ok":false,"summary":{},"target":{}}),
            json!({"ok":false,"summary":{},"issues":[],"target":{},"code":"stale_state"}),
            json!({"ok":false,"summary":{},"issues":[],"target":{},"status":"cancelled"}),
        ] {
            assert!(audit_result(
                &json!({"isError":true,"content":[{"type":"text","text":value.to_string()}]})
            )
            .is_err());
        }
        assert!(audit_result(
            &json!({"isError":true,"content":[{"type":"text","text":"Missing session"}]})
        )
        .is_err());
    }
    #[test]
    #[ignore = "requires OCS_MCP_EXECUTABLE pointing to a real desktop binary; no GUI is launched"]
    fn live_real_binary_handshake_and_tool_catalogue() -> Result<()> {
        let executable =
            std::env::var_os("OCS_MCP_EXECUTABLE").context("Set OCS_MCP_EXECUTABLE")?;
        let mut client = McpClient::spawn(Path::new(&executable), Duration::from_secs(30))?;
        let tools = client.tools()?;
        let names: HashSet<_> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        for tool in ToolName::ALL {
            ensure!(names.contains(tool.as_str()), "Missing {}", tool.as_str());
        }
        let sessions = client.tool("ocs_sessions", json!({"launch_if_none":false}))?;
        ensure!(sessions["result"].is_array(), "Missing session array");
        Ok(())
    }
}
