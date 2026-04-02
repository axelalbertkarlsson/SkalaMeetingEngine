use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::types::OperationAck;

const CODEX_APP_EVENT: &str = "codex://app-event";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const TURN_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_DYNAMIC_TOOL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DYNAMIC_TOOL_OUTPUT_CHARS: usize = 24_000;

#[derive(Clone, Default)]
pub struct CodexAppServerState {
    connections: Arc<Mutex<HashMap<String, Arc<CodexAppConnection>>>>,
}

impl CodexAppServerState {
    fn insert(
        &self,
        connection_id: String,
        connection: Arc<CodexAppConnection>,
    ) -> Result<(), String> {
        let mut connections = self
            .connections
            .lock()
            .map_err(|_| "codex app-server state lock poisoned".to_string())?;
        connections.insert(connection_id, connection);
        Ok(())
    }

    fn get(&self, connection_id: &str) -> Result<Option<Arc<CodexAppConnection>>, String> {
        let connections = self
            .connections
            .lock()
            .map_err(|_| "codex app-server state lock poisoned".to_string())?;
        Ok(connections.get(connection_id).cloned())
    }

    fn remove(&self, connection_id: &str) -> Result<Option<Arc<CodexAppConnection>>, String> {
        let mut connections = self
            .connections
            .lock()
            .map_err(|_| "codex app-server state lock poisoned".to_string())?;
        Ok(connections.remove(connection_id))
    }
}

struct CodexAppConnection {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    workspace_path: std::path::PathBuf,
    next_request_id: AtomicU64,
    pending_requests: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    active_thread_id: Mutex<Option<String>>,
    active_turn_id: Mutex<Option<String>>,
    suppressed_command_output_delta_count: AtomicU64,
    exit_emitted: AtomicBool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicToolCallParams {
    thread_id: String,
    turn_id: String,
    call_id: String,
    tool: String,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct ShellCommandToolArgs {
    command: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    login: Option<bool>,
}

impl CodexAppConnection {
    fn new(child: Child, stdin: ChildStdin, workspace_path: std::path::PathBuf) -> Self {
        Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            workspace_path,
            next_request_id: AtomicU64::new(1),
            pending_requests: Mutex::new(HashMap::new()),
            active_thread_id: Mutex::new(None),
            active_turn_id: Mutex::new(None),
            suppressed_command_output_delta_count: AtomicU64::new(0),
            exit_emitted: AtomicBool::new(false),
        }
    }

    fn next_request_id(&self) -> u64 {
        self.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    fn set_active_thread_id(&self, thread_id: Option<String>) {
        if let Ok(mut active_thread_id) = self.active_thread_id.lock() {
            *active_thread_id = thread_id;
        }
    }

    fn active_thread_id(&self) -> Option<String> {
        self.active_thread_id
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn set_active_turn_id(&self, turn_id: Option<String>) {
        if let Ok(mut active_turn_id) = self.active_turn_id.lock() {
            *active_turn_id = turn_id;
        }
    }

    fn workspace_path(&self) -> &Path {
        &self.workspace_path
    }

    fn bump_suppressed_command_output_delta_count(&self) -> u64 {
        self.suppressed_command_output_delta_count
            .fetch_add(1, Ordering::Relaxed)
            + 1
    }

    fn reset_suppressed_command_output_delta_count(&self) -> u64 {
        self.suppressed_command_output_delta_count
            .swap(0, Ordering::Relaxed)
    }

    fn mark_exit_emitted(&self) -> bool {
        self.exit_emitted
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn write_message(&self, value: &Value) -> Result<(), String> {
        let serialized =
            serde_json::to_string(value).map_err(|error| format!("Failed to serialize request: {error}"))?;

        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "codex app-server stdin lock poisoned".to_string())?;
        stdin
            .write_all(serialized.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("Failed to write to Codex app-server stdin: {error}"))
    }

    fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let request_id = self.next_request_id();
        let (tx, rx) = mpsc::channel();

        {
            let mut pending = self
                .pending_requests
                .lock()
                .map_err(|_| "codex app-server pending request lock poisoned".to_string())?;
            pending.insert(request_id, tx);
        }

        let request = json!({
            "id": request_id,
            "method": method,
            "params": params,
        });
        let timeout = request_timeout_for_method(method);

        if let Err(error) = self.write_message(&request) {
            let _ = self.remove_pending_request(request_id);
            return Err(error);
        }

        if timeout > DEFAULT_REQUEST_TIMEOUT {
            append_codex_bridge_log(
                self.workspace_path(),
                "codex.app.request",
                &format!(
                    "Waiting up to {}s for app-server response to '{}' (request id {}).",
                    timeout.as_secs(),
                    method,
                    request_id
                ),
            );
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => {
                if timeout > DEFAULT_REQUEST_TIMEOUT {
                    append_codex_bridge_log(
                        self.workspace_path(),
                        "codex.app.request",
                        &format!(
                            "Received app-server response to '{}' (request id {}).",
                            method,
                            request_id
                        ),
                    );
                }
                result
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = self.remove_pending_request(request_id);
                append_codex_bridge_log(
                    self.workspace_path(),
                    "codex.app.request",
                    &format!(
                        "Timed out after {}s waiting for app-server response to '{}' (request id {}).",
                        timeout.as_secs(),
                        method,
                        request_id
                    ),
                );
                Err(format!("Timed out waiting for Codex app-server response to '{method}'."))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = self.remove_pending_request(request_id);
                append_codex_bridge_log(
                    self.workspace_path(),
                    "codex.app.request",
                    &format!(
                        "App-server disconnected while waiting for '{}' (request id {}).",
                        method,
                        request_id
                    ),
                );
                Err("Codex app-server disconnected while waiting for a response.".to_string())
            }
        }
    }

    fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(&json!({
            "method": method,
            "params": params,
        }))
    }

    fn resolve_pending_request(&self, request_id: u64, result: Result<Value, String>) {
        if let Ok(mut pending) = self.pending_requests.lock() {
            if let Some(tx) = pending.remove(&request_id) {
                let _ = tx.send(result);
            }
        }
    }

    fn remove_pending_request(&self, request_id: u64) -> Option<mpsc::Sender<Result<Value, String>>> {
        self.pending_requests
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppConnectRequest {
    pub workspace_path: String,
    pub command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppConnectResponse {
    pub connection_id: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppListThreadsRequest {
    pub connection_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppListThreadsResponse {
    pub threads: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppListModelsRequest {
    pub connection_id: String,
    pub include_hidden: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppListModelsResponse {
    pub models: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppReadConfigRequest {
    pub connection_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppReadConfigResponse {
    pub config: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppThreadRequest {
    pub connection_id: String,
    pub thread_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppThreadResponse {
    pub thread: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppStartThreadRequest {
    pub connection_id: String,
    pub workspace_path: String,
    pub model: Option<String>,
    pub access_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppResumeThreadRequest {
    pub connection_id: String,
    pub thread_id: String,
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppSendTurnRequest {
    pub connection_id: String,
    pub prompt: String,
    pub expected_turn_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppSendTurnResponse {
    pub turn_id: String,
    pub turn: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppStopRequest {
    pub connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppServerRequestResponse {
    pub connection_id: String,
    pub request_id: Value,
    pub result: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodexAppEventPayload {
    Notification {
        connection_id: String,
        method: String,
        params: Value,
    },
    ServerRequest {
        connection_id: String,
        request_id: Value,
        method: String,
        params: Value,
    },
    Stderr {
        connection_id: String,
        text: String,
    },
    Lifecycle {
        connection_id: String,
        phase: CodexAppLifecyclePhase,
        message: String,
        thread_id: Option<String>,
    },
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum CodexAppLifecyclePhase {
    Connected,
    Stopped,
    Error,
}

struct SpawnAttempt {
    program: String,
    args: Vec<String>,
}

fn render_command_line(program: &str, args: &[String]) -> String {
    let quote = |value: &str| -> String {
        if value.is_empty() || value.chars().any(char::is_whitespace) {
            format!("\"{}\"", value.replace('"', "\\\""))
        } else {
            value.to_string()
        }
    };

    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote(program));
    for arg in args {
        parts.push(quote(arg));
    }
    parts.join(" ")
}

fn make_spawn_attempt(command: &str, request_args: &[String]) -> SpawnAttempt {
    #[cfg(target_os = "windows")]
    {
        let extension = Path::new(command)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());

        if matches!(extension.as_deref(), Some("cmd" | "bat")) {
            let mut args = Vec::with_capacity(request_args.len() + 2);
            args.push("/C".to_string());
            args.push(command.to_string());
            args.extend(request_args.iter().cloned());

            return SpawnAttempt {
                program: "cmd.exe".to_string(),
                args,
            };
        }

        if matches!(extension.as_deref(), Some("ps1")) {
            let mut args = vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                command.to_string(),
            ];
            args.extend(request_args.iter().cloned());

            return SpawnAttempt {
                program: "powershell.exe".to_string(),
                args,
            };
        }
    }

    SpawnAttempt {
        program: command.to_string(),
        args: request_args.to_vec(),
    }
}

#[cfg(target_os = "windows")]
fn windows_store_codex_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        candidates.push(
            Path::new(&local_app_data)
                .join("Microsoft")
                .join("WindowsApps")
                .join("codex.exe")
                .to_string_lossy()
                .to_string(),
        );
    }

    if let Ok(program_files) = env::var("ProgramFiles") {
        let windows_apps = Path::new(&program_files).join("WindowsApps");
        if let Ok(entries) = fs::read_dir(windows_apps) {
            let mut discovered = entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let name = entry.file_name().into_string().ok()?;
                    if !name.starts_with("OpenAI.Codex_") {
                        return None;
                    }

                    let candidate = entry.path().join("app").join("resources").join("codex.exe");
                    candidate
                        .is_file()
                        .then(|| candidate.to_string_lossy().to_string())
                })
                .collect::<Vec<_>>();

            discovered.sort();
            discovered.reverse();
            candidates.extend(discovered);
        }
    }

    candidates
}

fn build_spawn_attempts(command: &str, request_args: &[String]) -> Vec<SpawnAttempt> {
    let trimmed = command.trim();
    let normalized = if trimmed.is_empty() { "codex" } else { trimmed };
    let mut attempts = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if normalized.eq_ignore_ascii_case("codex") {
            attempts.push(make_spawn_attempt("codex.exe", request_args));
            for candidate in windows_store_codex_candidates() {
                attempts.push(make_spawn_attempt(&candidate, request_args));
            }
            attempts.push(make_spawn_attempt("codex", request_args));
            attempts.push(make_spawn_attempt("codex.cmd", request_args));

            if let Ok(app_data) = env::var("APPDATA") {
                let npm_dir = Path::new(&app_data).join("npm");
                let cmd_candidate = npm_dir.join("codex.cmd").to_string_lossy().to_string();
                attempts.push(make_spawn_attempt(&cmd_candidate, request_args));

                let ps1_candidate = npm_dir.join("codex.ps1").to_string_lossy().to_string();
                attempts.push(make_spawn_attempt(&ps1_candidate, request_args));
            }
        } else {
            attempts.push(make_spawn_attempt(normalized, request_args));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        attempts.push(make_spawn_attempt(normalized, request_args));
    }

    let mut deduped = Vec::with_capacity(attempts.len());
    let mut seen = HashSet::with_capacity(attempts.len());
    for attempt in attempts {
        let key = format!("{}|{}", attempt.program, attempt.args.join("\u{1f}"));
        if seen.insert(key) {
            deduped.push(attempt);
        }
    }

    deduped
}

fn spawn_codex_app_server_process(command: &str) -> Result<Child, String> {
    let request_args = vec![
        "app-server".to_string(),
        "--session-source".to_string(),
        "skala_meeting_engine".to_string(),
    ];

    let attempts = build_spawn_attempts(command, &request_args);
    let mut errors = Vec::new();

    for attempt in attempts {
        let display = render_command_line(&attempt.program, &attempt.args);
        let mut process = Command::new(&attempt.program);
        process
            .args(&attempt.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        match process.spawn() {
            Ok(child) => return Ok(child),
            Err(error) => errors.push(format!("{display} -> {error}")),
        }
    }

    Err(format!(
        "Failed to start `codex app-server`. Attempts: {}",
        errors.join(" | ")
    ))
}

fn emit_codex_app_event(app: &AppHandle, payload: &CodexAppEventPayload) {
    let _ = app.emit(CODEX_APP_EVENT, payload);
}

fn codex_bridge_log_path(workspace_path: &Path) -> std::path::PathBuf {
    workspace_path
        .join(".skala")
        .join("logs")
        .join("codex-app-bridge.log")
}

fn append_codex_bridge_log(workspace_path: &Path, scope: &str, message: &str) {
    let log_path = codex_bridge_log_path(workspace_path);
    if let Some(parent) = log_path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }

    let timestamp = chrono::Utc::now().to_rfc3339();
    let bounded_message = if message.len() > 1_000 {
        format!("{}...", &message[..1_000])
    } else {
        message.to_string()
    };
    let line = format!("{timestamp} [{scope}] {bounded_message}\n");

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn summarize_value_for_log(value: &Value) -> String {
    let serialized = serde_json::to_string(value).unwrap_or_else(|_| "<unserializable>".to_string());
    if serialized.len() > 600 {
        format!("{}...", &serialized[..600])
    } else {
        serialized
    }
}

fn format_child_exit_message(status: std::process::ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("Codex app-server stopped with exit code {code}."),
        None => "Codex app-server stopped.".to_string(),
    }
}

fn request_timeout_for_method(method: &str) -> Duration {
    match method {
        "turn/start" | "turn/steer" => TURN_REQUEST_TIMEOUT,
        _ => DEFAULT_REQUEST_TIMEOUT,
    }
}

fn parse_request_id(value: &Value) -> Option<u64> {
    value.as_u64()
}

fn extract_thread_id_from_value(value: &Value) -> Option<String> {
    value.pointer("/thread/id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn extract_turn_id_from_value(value: &Value) -> Option<String> {
    value.pointer("/turn/id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn extract_turn_from_send_result(value: &Value) -> Option<Value> {
    value.get("turn").cloned().or_else(|| {
        if value.get("id").and_then(Value::as_str).is_some() {
            Some(value.clone())
        } else {
            None
        }
    })
}

fn normalized_non_empty_option(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(ToString::to_string)
}

fn approval_policy_for_access_mode(access_mode: Option<&str>) -> &'static str {
    match access_mode.map(str::trim) {
        Some("ask") => "on-request",
        _ => "never",
    }
}

fn sandbox_for_access_mode(access_mode: Option<&str>) -> &'static str {
    match access_mode.map(str::trim) {
        Some("full_access") => "danger-full-access",
        _ => "workspace-write",
    }
}

fn build_thread_start_params(workspace_path: &str, model: Option<&str>, access_mode: Option<&str>) -> Value {
    let mut params = Map::new();
    params.insert(
        "approvalPolicy".to_string(),
        json!(approval_policy_for_access_mode(access_mode)),
    );
    params.insert("cwd".to_string(), json!(workspace_path));
    params.insert("personality".to_string(), json!("pragmatic"));
    params.insert("sandbox".to_string(), json!(sandbox_for_access_mode(access_mode)));
    params.insert("serviceName".to_string(), json!("skala_meeting_engine"));

    if let Some(model) = normalized_non_empty_option(model) {
        params.insert("model".to_string(), json!(model));
    }

    Value::Object(params)
}

fn build_thread_resume_params(thread_id: &str, model: Option<&str>) -> Value {
    let mut params = Map::new();
    params.insert("id".to_string(), json!(thread_id));

    if let Some(model) = normalized_non_empty_option(model) {
        params.insert("model".to_string(), json!(model));
    }

    Value::Object(params)
}

fn truncate_dynamic_tool_output(text: String) -> String {
    let total_chars = text.chars().count();
    if total_chars <= MAX_DYNAMIC_TOOL_OUTPUT_CHARS {
        return text;
    }

    let truncated = text
        .chars()
        .take(MAX_DYNAMIC_TOOL_OUTPUT_CHARS)
        .collect::<String>();
    format!("{truncated}\n\n[output truncated for display]")
}

fn build_dynamic_tool_text_response(text: String, success: bool) -> Value {
    json!({
        "contentItems": [
            {
                "type": "inputText",
                "text": truncate_dynamic_tool_output(text),
            }
        ],
        "success": success,
    })
}

fn append_command_section(buffer: &mut String, label: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }

    if !buffer.is_empty() {
        buffer.push('\n');
    }

    buffer.push_str(label);
    buffer.push_str(":\n");
    buffer.push_str(text.trim_end());
    buffer.push('\n');
}

fn format_wall_time(duration: Duration) -> String {
    format!("{:.1}", duration.as_secs_f64())
}

fn read_child_stream(mut stream: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stream.read_to_end(&mut bytes);
        bytes
    })
}

fn execute_shell_command_tool(
    connection: &Arc<CodexAppConnection>,
    tool_call: &DynamicToolCallParams,
) -> Result<Value, String> {
    let args: ShellCommandToolArgs = serde_json::from_value(tool_call.arguments.clone())
        .map_err(|error| format!("Invalid shell_command arguments: {error}"))?;
    let trimmed_command = args.command.trim();
    if trimmed_command.is_empty() {
        return Ok(build_dynamic_tool_text_response(
            "shell_command failed: command was empty.".to_string(),
            false,
        ));
    }

    let requested_workdir = args
        .workdir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| connection.workspace_path().to_string_lossy().to_string());
    let timeout = args
        .timeout_ms
        .map(Duration::from_millis)
        .filter(|duration| !duration.is_zero())
        .unwrap_or(DEFAULT_DYNAMIC_TOOL_TIMEOUT);
    let login = args.login.unwrap_or(true);

    let mut process = Command::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
    process
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(trimmed_command)
        .current_dir(&requested_workdir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let start = Instant::now();
    let mut child = process.spawn().map_err(|error| {
        format!(
            "Failed to spawn shell_command '{}' in '{}': {}",
            trimmed_command, requested_workdir, error
        )
    })?;

    let stdout_reader = child
        .stdout
        .take()
        .map(read_child_stream)
        .ok_or_else(|| "shell_command did not expose stdout.".to_string())?;
    let stderr_reader = child
        .stderr
        .take()
        .map(read_child_stream)
        .ok_or_else(|| "shell_command did not expose stderr.".to_string())?;

    let mut timed_out = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break child
                        .wait()
                        .map_err(|error| format!("Failed to wait for timed out shell_command: {error}"))?;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("Failed while waiting for shell_command: {error}"));
            }
        }
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| "shell_command stdout reader thread panicked.".to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "shell_command stderr reader thread panicked.".to_string())?;

    let stdout_text = String::from_utf8_lossy(&stdout).into_owned();
    let stderr_text = String::from_utf8_lossy(&stderr).into_owned();
    let wall_time = format_wall_time(start.elapsed());
    let exit_code = exit_status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "terminated".to_string());

    let mut output = String::new();
    output.push_str(&format!("Exit code: {exit_code}\n"));
    output.push_str(&format!("Wall time: {wall_time} seconds\n"));
    if timed_out {
        output.push_str(&format!("Timed out after {} seconds\n", format_wall_time(timeout)));
    }

    let mut body = String::new();
    append_command_section(&mut body, "Output", &stdout_text);
    append_command_section(&mut body, "Errors", &stderr_text);
    if body.is_empty() {
        body.push_str("Output:\n");
    }
    output.push_str(&body);

    let success = exit_status.success() && !timed_out;
    append_codex_bridge_log(
        connection.workspace_path(),
        "codex.app.dynamic_tool",
        &format!(
            "Completed shell_command call '{}' for turn '{}' with success={} exit_code={} login={} workdir='{}' command='{}'.",
            tool_call.call_id,
            tool_call.turn_id,
            success,
            exit_code,
            login,
            requested_workdir,
            trimmed_command
        ),
    );

    Ok(build_dynamic_tool_text_response(output, success))
}

fn build_unsupported_dynamic_tool_response(tool: &str) -> Value {
    build_dynamic_tool_text_response(
        format!("Unsupported dynamic tool call: {tool}"),
        false,
    )
}

fn spawn_dynamic_tool_call_handler(
    connection: Arc<CodexAppConnection>,
    workspace_path: std::path::PathBuf,
    request_id: Value,
    tool_call: DynamicToolCallParams,
) {
    thread::spawn(move || {
        append_codex_bridge_log(
            &workspace_path,
            "codex.app.dynamic_tool",
            &format!(
                "Executing dynamic tool call '{}' for tool '{}' on thread '{}' turn '{}'.",
                tool_call.call_id,
                tool_call.tool,
                tool_call.thread_id,
                tool_call.turn_id
            ),
        );

        let result = match tool_call.tool.as_str() {
            "shell_command" => execute_shell_command_tool(&connection, &tool_call),
            other => Ok(build_unsupported_dynamic_tool_response(other)),
        }
        .unwrap_or_else(|error| build_dynamic_tool_text_response(error, false));

        if let Err(error) = connection.write_message(&json!({
            "id": request_id,
            "result": result,
        })) {
            append_codex_bridge_log(
                &workspace_path,
                "codex.app.dynamic_tool",
                &format!(
                    "Failed to send dynamic tool response for call '{}': {}",
                    tool_call.call_id,
                    error
                ),
            );
        }
    });
}

fn should_emit_server_message_to_renderer(method_name: &str) -> bool {
    method_name != "item/commandExecution/outputDelta"
}

fn handle_server_message(
    app: &AppHandle,
    state: &CodexAppServerState,
    connection_id: &str,
    connection: &Arc<CodexAppConnection>,
    value: Value,
) {
    let method = value.get("method").and_then(Value::as_str).map(ToString::to_string);
    let id = value.get("id").cloned();

    if let Some(request_id) = id.as_ref().and_then(parse_request_id) {
        if value.get("result").is_some() || value.get("error").is_some() {
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server request failed.")
                    .to_string();
                connection.resolve_pending_request(request_id, Err(message));
            } else {
                connection.resolve_pending_request(
                    request_id,
                    Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                );
            }
            return;
        }
    }

    if let Some(method_name) = method {
        let params = value.get("params").cloned().unwrap_or(Value::Null);

        if method_name == "item/tool/call" {
            let request_id = id.clone().unwrap_or(Value::Null);
            match serde_json::from_value::<DynamicToolCallParams>(params.clone()) {
                Ok(tool_call) => {
                    append_codex_bridge_log(
                        connection.workspace_path(),
                        "codex.app.bridge",
                        &format!(
                            "Received dynamic tool call request for tool '{}' (call '{}', turn '{}').",
                            tool_call.tool,
                            tool_call.call_id,
                            tool_call.turn_id
                        ),
                    );
                    spawn_dynamic_tool_call_handler(
                        connection.clone(),
                        connection.workspace_path().to_path_buf(),
                        request_id,
                        tool_call,
                    );
                    return;
                }
                Err(error) => {
                    append_codex_bridge_log(
                        connection.workspace_path(),
                        "codex.app.bridge",
                        &format!(
                            "Failed to parse dynamic tool call request params: {}",
                            error
                        ),
                    );
                    let _ = connection.write_message(&json!({
                        "id": request_id,
                        "result": build_dynamic_tool_text_response(
                            format!("Failed to parse dynamic tool call request: {error}"),
                            false
                        ),
                    }));
                    return;
                }
            }
        }

        if method_name == "item/commandExecution/outputDelta" {
            let skipped_count = connection.bump_suppressed_command_output_delta_count();
            if skipped_count == 1 || skipped_count % 250 == 0 {
                append_codex_bridge_log(
                    connection.workspace_path(),
                    "codex.app.bridge",
                    &format!(
                        "Suppressed commandExecution output delta #{skipped_count} for connection {connection_id}."
                    ),
                );
            }
        } else if matches!(
            method_name.as_str(),
            "thread/started"
                | "turn/started"
                | "turn/completed"
                | "error"
                | "item/started"
                | "item/completed"
        ) {
            append_codex_bridge_log(
                connection.workspace_path(),
                "codex.app.bridge",
                &format!(
                    "Received method '{}' with params {}",
                    method_name,
                    summarize_value_for_log(&params)
                ),
            );
        }

        match method_name.as_str() {
            "thread/started" => {
                connection.set_active_thread_id(extract_thread_id_from_value(&params));
            }
            "turn/started" => {
                connection.set_active_turn_id(extract_turn_id_from_value(&params));
            }
            "turn/completed" => {
                let completed_turn_id = extract_turn_id_from_value(&params);
                if completed_turn_id.is_some() {
                    connection.set_active_turn_id(None);
                }
                let suppressed_count = connection.reset_suppressed_command_output_delta_count();
                if suppressed_count > 0 {
                    append_codex_bridge_log(
                        connection.workspace_path(),
                        "codex.app.bridge",
                        &format!(
                            "Reset suppressed commandExecution output delta count at turn completion: {suppressed_count}."
                        ),
                    );
                }
            }
            _ => {}
        }

        if method_name == "item/completed" {
            let item_type = params.pointer("/item/type").and_then(Value::as_str);
            if item_type == Some("commandExecution") {
                let suppressed_count = connection.reset_suppressed_command_output_delta_count();
                append_codex_bridge_log(
                    connection.workspace_path(),
                    "codex.app.bridge",
                    &format!(
                        "Completed commandExecution item with suppressed delta count {} and params {}",
                        suppressed_count,
                        summarize_value_for_log(&params)
                    ),
                );
            }
        }

        if !should_emit_server_message_to_renderer(&method_name) {
            return;
        }

        if id.is_some() {
            emit_codex_app_event(
                app,
                &CodexAppEventPayload::ServerRequest {
                    connection_id: connection_id.to_string(),
                    request_id: id.unwrap_or(Value::Null),
                    method: method_name,
                    params,
                },
            );
        } else {
            emit_codex_app_event(
                app,
                &CodexAppEventPayload::Notification {
                    connection_id: connection_id.to_string(),
                    method: method_name,
                    params,
                },
            );
        }
        return;
    }

    emit_codex_app_event(
        app,
        &CodexAppEventPayload::Lifecycle {
            connection_id: connection_id.to_string(),
            phase: CodexAppLifecyclePhase::Error,
            message: format!("Received unrecognized app-server payload: {value}"),
            thread_id: connection.active_thread_id(),
        },
    );

    let _ = state.remove(connection_id);
}

fn spawn_stdout_reader(
    app: AppHandle,
    state: CodexAppServerState,
    connection_id: String,
    connection: Arc<CodexAppConnection>,
    stdout: ChildStdout,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }

                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) => handle_server_message(&app, &state, &connection_id, &connection, value),
                        Err(error) => {
                            append_codex_bridge_log(
                                connection.workspace_path(),
                                "codex.app.bridge",
                                &format!("Failed to parse Codex app-server JSON: {error}. Line: {}", line),
                            );
                            emit_codex_app_event(
                                &app,
                                &CodexAppEventPayload::Lifecycle {
                                    connection_id: connection_id.clone(),
                                    phase: CodexAppLifecyclePhase::Error,
                                    message: format!("Failed to parse Codex app-server JSON: {error}"),
                                    thread_id: connection.active_thread_id(),
                                },
                            );
                        }
                    }
                }
                Err(error) => {
                    append_codex_bridge_log(
                        connection.workspace_path(),
                        "codex.app.bridge",
                        &format!("Failed to read Codex app-server stdout: {error}"),
                    );
                    emit_codex_app_event(
                        &app,
                        &CodexAppEventPayload::Lifecycle {
                            connection_id: connection_id.clone(),
                            phase: CodexAppLifecyclePhase::Error,
                            message: format!("Failed to read Codex app-server stdout: {error}"),
                            thread_id: connection.active_thread_id(),
                        },
                    );
                    break;
                }
            }
        }

        finalize_connection_shutdown(&app, &state, &connection_id, &connection);
    });
}

fn spawn_stderr_reader(
    app: AppHandle,
    connection_id: String,
    connection: Arc<CodexAppConnection>,
    stderr: ChildStderr,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }

                    append_codex_bridge_log(
                        connection.workspace_path(),
                        "codex.app.stderr",
                        &line,
                    );

                    emit_codex_app_event(
                        &app,
                        &CodexAppEventPayload::Stderr {
                            connection_id: connection_id.clone(),
                            text: line,
                        },
                    );
                }
                Err(error) => {
                    append_codex_bridge_log(
                        connection.workspace_path(),
                        "codex.app.bridge",
                        &format!("Failed to read Codex app-server stderr: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_child_exit_watcher(
    app: AppHandle,
    state: CodexAppServerState,
    connection_id: String,
    connection: Arc<CodexAppConnection>,
) {
    thread::spawn(move || loop {
        if connection.exit_emitted.load(Ordering::SeqCst) {
            return;
        }

        let exit_message = {
            let mut child = match connection.child.lock() {
                Ok(child) => child,
                Err(_) => {
                    append_codex_bridge_log(
                        connection.workspace_path(),
                        "codex.app.bridge",
                        "Child exit watcher could not lock Codex child process.",
                    );
                    return;
                }
            };

            match child.try_wait() {
                Ok(Some(status)) => Some(format_child_exit_message(status)),
                Ok(None) => None,
                Err(error) => Some(format!("Codex app-server try_wait failed: {error}")),
            }
        };

        if let Some(exit_message) = exit_message {
            append_codex_bridge_log(
                connection.workspace_path(),
                "codex.app.bridge",
                &format!("Child exit watcher observed process exit: {exit_message}"),
            );
            finalize_connection_shutdown(&app, &state, &connection_id, &connection);
            return;
        }

        thread::sleep(Duration::from_millis(250));
    });
}

fn finalize_connection_shutdown(
    app: &AppHandle,
    state: &CodexAppServerState,
    connection_id: &str,
    connection: &Arc<CodexAppConnection>,
) {
    if !connection.mark_exit_emitted() {
        return;
    }

    let exit_message = {
        let mut child = match connection.child.lock() {
            Ok(child) => child,
            Err(_) => {
                emit_codex_app_event(
                    app,
                    &CodexAppEventPayload::Lifecycle {
                        connection_id: connection_id.to_string(),
                        phase: CodexAppLifecyclePhase::Stopped,
                        message: "Codex app-server stopped.".to_string(),
                        thread_id: connection.active_thread_id(),
                    },
                );
                let _ = state.remove(connection_id);
                return;
            }
        };

        match child.wait() {
            Ok(status) => format_child_exit_message(status),
            Err(error) => format!("Codex app-server stopped ({error})."),
        }
    };

    let _ = state.remove(connection_id);

    append_codex_bridge_log(
        connection.workspace_path(),
        "codex.app.bridge",
        &format!("Connection finalized: {exit_message}"),
    );

    emit_codex_app_event(
        app,
        &CodexAppEventPayload::Lifecycle {
            connection_id: connection_id.to_string(),
            phase: CodexAppLifecyclePhase::Stopped,
            message: exit_message,
            thread_id: connection.active_thread_id(),
        },
    );
}

#[tauri::command]
pub fn codex_app_connect(
    app: AppHandle,
    state: State<CodexAppServerState>,
    request: CodexAppConnectRequest,
) -> Result<CodexAppConnectResponse, String> {
    let mut child = spawn_codex_app_server_process(&request.command)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server did not expose stdin.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server did not expose stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server did not expose stderr.".to_string())?;

    let connection_id = format!("codex-app-{}", Uuid::new_v4());
    let workspace_path = std::path::PathBuf::from(&request.workspace_path);
    append_codex_bridge_log(
        &workspace_path,
        "codex.app.bridge",
        &format!(
            "Connecting Codex app-server with command '{}' and workspace '{}'.",
            request.command,
            request.workspace_path
        ),
    );
    let connection = Arc::new(CodexAppConnection::new(child, stdin, workspace_path));

    state.insert(connection_id.clone(), connection.clone())?;
    spawn_stdout_reader(app.clone(), state.inner().clone(), connection_id.clone(), connection.clone(), stdout);
    spawn_stderr_reader(app.clone(), connection_id.clone(), connection.clone(), stderr);
    spawn_child_exit_watcher(app.clone(), state.inner().clone(), connection_id.clone(), connection.clone());

    connection.send_request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "skala_meeting_engine",
                "title": "Skala Meeting Engine",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }),
    )?;
    connection.send_notification("initialized", json!({}))?;

    emit_codex_app_event(
        &app,
        &CodexAppEventPayload::Lifecycle {
            connection_id: connection_id.clone(),
            phase: CodexAppLifecyclePhase::Connected,
            message: "Connected to Codex app-server.".to_string(),
            thread_id: None,
        },
    );

    Ok(CodexAppConnectResponse {
        connection_id,
        message: "Connected to Codex app-server.".to_string(),
    })
}

#[tauri::command]
pub fn codex_app_list_threads(
    state: State<CodexAppServerState>,
    request: CodexAppListThreadsRequest,
) -> Result<CodexAppListThreadsResponse, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    let result = connection.send_request(
        "thread/list",
        json!({
            "cwd": request.cwd,
        }),
    )?;

    let threads = result
        .get("threads")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(CodexAppListThreadsResponse { threads })
}

#[tauri::command]
pub fn codex_app_list_models(
    state: State<CodexAppServerState>,
    request: CodexAppListModelsRequest,
) -> Result<CodexAppListModelsResponse, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    let include_hidden = request.include_hidden.unwrap_or(false);
    let mut models = Vec::new();
    let mut next_cursor: Option<Value> = None;

    loop {
        let mut params = Map::new();
        params.insert("limit".to_string(), json!(100));
        params.insert("includeHidden".to_string(), json!(include_hidden));

        if let Some(cursor) = next_cursor.take() {
            params.insert("cursor".to_string(), cursor);
        }

        let result = connection.send_request("model/list", Value::Object(params))?;

        let mut page_models = result
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| result.get("models").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        models.append(&mut page_models);

        next_cursor = result.get("nextCursor").cloned().filter(|cursor| !cursor.is_null());
        if next_cursor.is_none() {
            break;
        }
    }

    Ok(CodexAppListModelsResponse { models })
}

#[tauri::command]
pub fn codex_app_read_config(
    state: State<CodexAppServerState>,
    request: CodexAppReadConfigRequest,
) -> Result<CodexAppReadConfigResponse, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    let result = connection.send_request("config/read", json!({}))?;
    let config = result.get("config").cloned().unwrap_or(result);

    Ok(CodexAppReadConfigResponse { config })
}

#[tauri::command]
pub fn codex_app_read_thread(
    state: State<CodexAppServerState>,
    request: CodexAppThreadRequest,
) -> Result<CodexAppThreadResponse, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    let result = connection.send_request(
        "thread/read",
        json!({
            "id": request.thread_id,
            "includeTurns": true,
        }),
    )?;

    let thread = result
        .get("thread")
        .cloned()
        .unwrap_or(result);

    Ok(CodexAppThreadResponse { thread })
}

#[tauri::command]
pub fn codex_app_resume_thread(
    state: State<CodexAppServerState>,
    request: CodexAppResumeThreadRequest,
) -> Result<CodexAppThreadResponse, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    let result = connection.send_request(
        "thread/resume",
        build_thread_resume_params(&request.thread_id, request.model.as_deref()),
    )?;

    let thread = result
        .get("thread")
        .cloned()
        .unwrap_or(result);
    let thread_id = extract_thread_id_from_value(&json!({ "thread": thread.clone() }))
        .or_else(|| thread.get("id").and_then(Value::as_str).map(ToString::to_string))
        .ok_or_else(|| "Codex app-server thread/resume response did not include a thread id.".to_string())?;
    connection.set_active_thread_id(Some(thread_id));

    Ok(CodexAppThreadResponse { thread })
}

#[tauri::command]
pub fn codex_app_start_thread(
    state: State<CodexAppServerState>,
    request: CodexAppStartThreadRequest,
) -> Result<CodexAppThreadResponse, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    let result = connection.send_request(
        "thread/start",
        build_thread_start_params(
            &request.workspace_path,
            request.model.as_deref(),
            request.access_mode.as_deref(),
        ),
    )?;

    let thread = result
        .get("thread")
        .cloned()
        .unwrap_or(result);
    let thread_id = extract_thread_id_from_value(&json!({ "thread": thread.clone() }))
        .or_else(|| thread.get("id").and_then(Value::as_str).map(ToString::to_string))
        .ok_or_else(|| "Codex app-server thread/start response did not include a thread id.".to_string())?;
    connection.set_active_thread_id(Some(thread_id));

    Ok(CodexAppThreadResponse { thread })
}

#[tauri::command]
pub fn codex_app_archive_thread(
    state: State<CodexAppServerState>,
    request: CodexAppThreadRequest,
) -> Result<OperationAck, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    connection.send_request(
        "thread/archive",
        json!({
            "id": request.thread_id,
        }),
    )?;

    if connection.active_thread_id().as_deref() == Some(request.thread_id.as_str()) {
        connection.set_active_thread_id(None);
        connection.set_active_turn_id(None);
    }

    Ok(OperationAck {
        ok: true,
        message: "Archived Codex thread.".to_string(),
    })
}

#[tauri::command]
pub fn codex_app_send_turn(
    state: State<CodexAppServerState>,
    request: CodexAppSendTurnRequest,
) -> Result<CodexAppSendTurnResponse, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;
    let thread_id = connection
        .active_thread_id()
        .ok_or_else(|| "Codex app-server thread not started.".to_string())?;

    let result = if let Some(expected_turn_id) = request.expected_turn_id {
        connection.send_request(
            "turn/steer",
            json!({
                "approvalPolicy": approval_policy_for_access_mode(request.access_mode.as_deref()),
                "expectedTurnId": expected_turn_id,
                "input": [
                    {
                        "type": "text",
                        "text": request.prompt,
                    }
                ],
                "sandbox": sandbox_for_access_mode(request.access_mode.as_deref()),
                "threadId": thread_id,
            }),
        )?
    } else {
        connection.send_request(
            "turn/start",
            {
                let mut params = Map::new();
                params.insert(
                    "approvalPolicy".to_string(),
                    json!(approval_policy_for_access_mode(request.access_mode.as_deref())),
                );
                params.insert(
                    "input".to_string(),
                    json!([
                        {
                            "type": "text",
                            "text": request.prompt,
                        }
                    ]),
                );
                params.insert(
                    "sandbox".to_string(),
                    json!(sandbox_for_access_mode(request.access_mode.as_deref())),
                );
                params.insert("threadId".to_string(), json!(thread_id));

                if let Some(model) = normalized_non_empty_option(request.model.as_deref()) {
                    params.insert("model".to_string(), json!(model));
                }

                if let Some(effort) = normalized_non_empty_option(request.effort.as_deref()) {
                    params.insert("effort".to_string(), json!(effort));
                }

                Value::Object(params)
            },
        )?
    };

    let turn = extract_turn_from_send_result(&result);
    let turn_id = result
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| result.get("turnId").and_then(Value::as_str).map(ToString::to_string))
        .ok_or_else(|| "Codex app-server turn response did not include a turn id.".to_string())?;

    connection.set_active_turn_id(Some(turn_id.clone()));

    Ok(CodexAppSendTurnResponse { turn_id, turn })
}

#[tauri::command]
pub fn codex_app_stop(
    app: AppHandle,
    state: State<CodexAppServerState>,
    request: CodexAppStopRequest,
) -> Result<OperationAck, String> {
    let connection = state
        .remove(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    {
        let mut child = connection
            .child
            .lock()
            .map_err(|_| "codex app-server child lock poisoned".to_string())?;
        let _ = child.kill();
    }

    if connection.mark_exit_emitted() {
        emit_codex_app_event(
            &app,
            &CodexAppEventPayload::Lifecycle {
                connection_id: request.connection_id,
                phase: CodexAppLifecyclePhase::Stopped,
                message: "Stopped Codex app-server.".to_string(),
                thread_id: connection.active_thread_id(),
            },
        );
    }

    Ok(OperationAck {
        ok: true,
        message: "Stopped Codex app-server.".to_string(),
    })
}

#[tauri::command]
pub fn codex_app_respond_to_server_request(
    state: State<CodexAppServerState>,
    request: CodexAppServerRequestResponse,
) -> Result<OperationAck, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    connection.write_message(&json!({
        "id": request.request_id,
        "result": request.result,
    }))?;

    Ok(OperationAck {
        ok: true,
        message: "Responded to Codex app-server request.".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::should_emit_server_message_to_renderer;

    #[test]
    fn suppresses_command_execution_output_deltas_for_renderer_stability() {
        assert!(
            !should_emit_server_message_to_renderer("item/commandExecution/outputDelta")
        );
    }

    #[test]
    fn keeps_other_server_messages_visible_to_renderer() {
        assert!(should_emit_server_message_to_renderer("item/completed"));
        assert!(should_emit_server_message_to_renderer("item/agentMessage/delta"));
    }
}
