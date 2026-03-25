use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::types::OperationAck;

const CODEX_APP_EVENT: &str = "codex://app-event";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

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
    next_request_id: AtomicU64,
    pending_requests: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    active_thread_id: Mutex<Option<String>>,
    active_turn_id: Mutex<Option<String>>,
    exit_emitted: AtomicBool,
}

impl CodexAppConnection {
    fn new(child: Child, stdin: ChildStdin) -> Self {
        Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            next_request_id: AtomicU64::new(1),
            pending_requests: Mutex::new(HashMap::new()),
            active_thread_id: Mutex::new(None),
            active_turn_id: Mutex::new(None),
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

        if let Err(error) = self.write_message(&request) {
            let _ = self.remove_pending_request(request_id);
            return Err(error);
        }

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = self.remove_pending_request(request_id);
                Err(format!("Timed out waiting for Codex app-server response to '{method}'."))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = self.remove_pending_request(request_id);
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexAppSendTurnRequest {
    pub connection_id: String,
    pub prompt: String,
    pub expected_turn_id: Option<String>,
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

fn build_thread_start_params(workspace_path: &str) -> Value {
    json!({
        "approvalPolicy": "never",
        "cwd": workspace_path,
        "personality": "pragmatic",
        "sandbox": "workspace-write",
        "serviceName": "skala_meeting_engine",
    })
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
            }
            _ => {}
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
                        Err(error) => emit_codex_app_event(
                            &app,
                            &CodexAppEventPayload::Lifecycle {
                                connection_id: connection_id.clone(),
                                phase: CodexAppLifecyclePhase::Error,
                                message: format!("Failed to parse Codex app-server JSON: {error}"),
                                thread_id: connection.active_thread_id(),
                            },
                        ),
                    }
                }
                Err(error) => {
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

fn spawn_stderr_reader(app: AppHandle, connection_id: String, stderr: ChildStderr) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }

                    emit_codex_app_event(
                        &app,
                        &CodexAppEventPayload::Stderr {
                            connection_id: connection_id.clone(),
                            text: line,
                        },
                    );
                }
                Err(_) => break,
            }
        }
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
            Ok(status) => match status.code() {
                Some(code) => format!("Codex app-server stopped with exit code {code}."),
                None => "Codex app-server stopped.".to_string(),
            },
            Err(error) => format!("Codex app-server stopped ({error})."),
        }
    };

    let _ = state.remove(connection_id);

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
    let connection = Arc::new(CodexAppConnection::new(child, stdin));

    state.insert(connection_id.clone(), connection.clone())?;
    spawn_stdout_reader(app.clone(), state.inner().clone(), connection_id.clone(), connection.clone(), stdout);
    spawn_stderr_reader(app.clone(), connection_id.clone(), stderr);

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
    request: CodexAppThreadRequest,
) -> Result<CodexAppThreadResponse, String> {
    let connection = state
        .get(&request.connection_id)?
        .ok_or_else(|| "Codex app-server connection not found.".to_string())?;

    let result = connection.send_request(
        "thread/resume",
        json!({
            "id": request.thread_id,
        }),
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
        build_thread_start_params(&request.workspace_path),
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
                "expectedTurnId": expected_turn_id,
                "input": [
                    {
                        "type": "text",
                        "text": request.prompt,
                    }
                ],
                "threadId": thread_id,
            }),
        )?
    } else {
        connection.send_request(
            "turn/start",
            json!({
                "approvalPolicy": "never",
                "input": [
                    {
                        "type": "text",
                        "text": request.prompt,
                    }
                ],
                "threadId": thread_id,
            }),
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
