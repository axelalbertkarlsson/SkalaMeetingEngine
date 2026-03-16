use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::types::OperationAck;

const TERMINAL_CHUNK_EVENT: &str = "codex://terminal-chunk";
const TERMINAL_EXIT_EVENT: &str = "codex://terminal-exit";
const MAX_PTY_BATCH_BYTES: usize = 8 * 1024;
const MAX_PTY_BATCH_DELAY: Duration = Duration::from_millis(10);

#[derive(Default)]
pub struct CodexSessionState {
    sessions: Arc<Mutex<HashMap<String, Arc<CodexSession>>>>,
}

impl CodexSessionState {
    fn insert(&self, session_id: String, session: Arc<CodexSession>) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "codex session registry lock poisoned".to_string())?;
        sessions.insert(session_id, session);
        Ok(())
    }

    fn get(&self, session_id: &str) -> Result<Option<Arc<CodexSession>>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "codex session registry lock poisoned".to_string())?;
        Ok(sessions.get(session_id).cloned())
    }
}

#[derive(Default)]
struct SessionSequence {
    next: AtomicU64,
}

impl SessionSequence {
    fn next_seq(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }
}

struct CodexSession {
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    sequence: SessionSequence,
    capture_bundle: Option<DebugCaptureBundle>,
}

impl CodexSession {
    fn new(
        child: Box<dyn portable_pty::Child + Send>,
        writer: Option<Box<dyn Write + Send>>,
        master: Box<dyn portable_pty::MasterPty + Send>,
        capture_bundle: Option<DebugCaptureBundle>,
    ) -> Self {
        Self {
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            master: Mutex::new(master),
            sequence: SessionSequence::default(),
            capture_bundle,
        }
    }

    fn next_seq(&self) -> u64 {
        self.sequence.next_seq()
    }

    fn capture_path(&self) -> Option<String> {
        self.capture_bundle
            .as_ref()
            .map(DebugCaptureBundle::path_string)
    }
}

#[derive(Clone)]
struct DebugCaptureBundle {
    bundle_dir: Arc<PathBuf>,
    backend_events: Arc<Mutex<File>>,
    frontend_events: Arc<Mutex<File>>,
}

impl DebugCaptureBundle {
    fn create(
        workspace_path: &str,
        session_id: &str,
        command_line: &str,
        request_args: &[String],
    ) -> Result<Self, String> {
        let capture_root = Path::new(workspace_path)
            .join(".skala")
            .join("codex-captures");
        fs::create_dir_all(&capture_root)
            .map_err(|error| format!("Failed to create capture root: {}", error))?;

        let bundle_dir = capture_root.join(format!("{}-{}", now_unix_ms(), session_id));
        fs::create_dir_all(&bundle_dir)
            .map_err(|error| format!("Failed to create capture bundle directory: {}", error))?;

        let manifest = json!({
            "session_id": session_id,
            "workspace_path": workspace_path,
            "command_line": command_line,
            "args": request_args,
            "created_at_ms": now_unix_ms(),
            "terminal_host": {
                "windows_pty": {
                    "backend": "conpty",
                    "build_number": detect_windows_build_number()
                }
            },
            "files": {
                "backend_events": "backend-events.ndjson",
                "frontend_events": "frontend-events.ndjson"
            }
        });

        let manifest_path = bundle_dir.join("manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("Failed to serialize capture manifest: {}", error))?,
        )
        .map_err(|error| format!("Failed to write capture manifest: {}", error))?;

        let backend_events = OpenOptions::new()
            .create(true)
            .append(true)
            .open(bundle_dir.join("backend-events.ndjson"))
            .map_err(|error| format!("Failed to open backend capture file: {}", error))?;

        let frontend_events = OpenOptions::new()
            .create(true)
            .append(true)
            .open(bundle_dir.join("frontend-events.ndjson"))
            .map_err(|error| format!("Failed to open frontend capture file: {}", error))?;

        Ok(Self {
            bundle_dir: Arc::new(bundle_dir),
            backend_events: Arc::new(Mutex::new(backend_events)),
            frontend_events: Arc::new(Mutex::new(frontend_events)),
        })
    }

    fn path_string(&self) -> String {
        self.bundle_dir.to_string_lossy().to_string()
    }

    fn write_backend_event(&self, event_type: &str, data: Value) {
        let event = json!({
            "source": "backend",
            "event_type": event_type,
            "timestamp_ms": now_unix_ms(),
            "data": data,
        });
        write_capture_line(&self.backend_events, event);
    }

    fn write_frontend_event(&self, event_type: &str, data: Value) {
        let event = json!({
            "source": "frontend",
            "event_type": event_type,
            "timestamp_ms": now_unix_ms(),
            "data": data,
        });
        write_capture_line(&self.frontend_events, event);
    }
}

fn write_capture_line(file: &Mutex<File>, value: Value) {
    let Ok(mut file_guard) = file.lock() else {
        return;
    };

    let Ok(serialized) = serde_json::to_string(&value) else {
        return;
    };

    let _ = writeln!(file_guard, "{}", serialized);
    let _ = file_guard.flush();
}

#[derive(Debug, Deserialize)]
pub struct SpawnCodexProcessRequest {
    pub workspace_path: String,
    pub command: String,
    pub args: Option<Vec<String>>,
    pub capture_debug_bundle: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct SpawnCodexProcessResponse {
    pub session_id: String,
    pub status: String,
    pub message: String,
    pub capture_bundle_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TerminalHostInfoResponse {
    pub windows_pty: Option<WindowsPtyInfoResponse>,
}

#[derive(Debug, Serialize)]
pub struct WindowsPtyInfoResponse {
    pub backend: String,
    pub build_number: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct SendCodexInputRequest {
    pub session_id: String,
    pub input: String,
}

#[derive(Debug, Deserialize)]
pub struct StopCodexProcessRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ResizeCodexTerminalRequest {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
pub struct RecordCodexCaptureEventsRequest {
    pub session_id: String,
    pub events: Vec<CaptureEventRequest>,
}

#[derive(Debug, Deserialize)]
pub struct CaptureEventRequest {
    pub event_type: String,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
pub struct ListCodexCaptureBundlesRequest {
    pub workspace_path: String,
}

#[derive(Debug, Deserialize)]
pub struct LoadCodexCaptureBundleRequest {
    pub bundle_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexCaptureBundleListItem {
    pub path: String,
    pub session_id: String,
    pub created_at_ms: u128,
    pub command_line: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexCaptureManifest {
    pub session_id: String,
    pub workspace_path: String,
    pub command_line: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub created_at_ms: u128,
    pub terminal_host: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodexCaptureReplayChunk {
    Pty {
        seq: u64,
        timestamp_ms: u128,
        data_base64: String,
    },
    System {
        seq: u64,
        timestamp_ms: u128,
        text: String,
    },
}

#[derive(Debug, Serialize)]
pub struct LoadCodexCaptureBundleResponse {
    pub manifest: CodexCaptureManifest,
    pub chunks: Vec<CodexCaptureReplayChunk>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TerminalChunkPayload {
    Pty {
        session_id: String,
        seq: u64,
        data_base64: String,
    },
    System {
        session_id: String,
        seq: u64,
        text: String,
    },
}

#[derive(Debug, Serialize, Clone)]
struct TerminalExitPayload {
    session_id: String,
    code: Option<i32>,
    capture_bundle_path: Option<String>,
}

struct SpawnAttempt {
    program: String,
    args: Vec<String>,
    display: String,
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
                display: render_command_line("cmd.exe", &args),
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
                display: render_command_line("powershell.exe", &args),
                args,
            };
        }
    }

    SpawnAttempt {
        program: command.to_string(),
        display: render_command_line(command, request_args),
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
        let key = format!("{}|{}", attempt.program, attempt.args.join(""));
        if seen.insert(key) {
            deduped.push(attempt);
        }
    }

    deduped
}

#[cfg(target_os = "windows")]
fn detect_windows_build_number() -> Option<u32> {
    let output = Command::new("cmd").args(["/C", "ver"]).output().ok()?;
    let stdout = String::from_utf8(output.stdout).ok()?;
    let version_marker = "Version ";
    let start = stdout.find(version_marker)? + version_marker.len();
    let version = stdout[start..].split(']').next()?.trim();

    version
        .split('.')
        .nth(2)
        .and_then(|segment| segment.parse::<u32>().ok())
}

#[cfg(not(target_os = "windows"))]
fn detect_windows_build_number() -> Option<u32> {
    None
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
struct StoredCaptureEvent {
    event_type: String,
    timestamp_ms: u128,
    data: Value,
}

fn read_capture_manifest(bundle_dir: &Path) -> Result<CodexCaptureManifest, String> {
    let manifest_path = bundle_dir.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "Failed to read capture manifest '{}': {}",
            manifest_path.display(),
            error
        )
    })?;

    serde_json::from_slice(&manifest_bytes).map_err(|error| {
        format!(
            "Failed to parse capture manifest '{}': {}",
            manifest_path.display(),
            error
        )
    })
}

fn read_capture_replay_chunks(bundle_dir: &Path) -> Result<Vec<CodexCaptureReplayChunk>, String> {
    let backend_events_path = bundle_dir.join("backend-events.ndjson");
    let backend_events = fs::read_to_string(&backend_events_path).map_err(|error| {
        format!(
            "Failed to read backend capture events '{}': {}",
            backend_events_path.display(),
            error
        )
    })?;

    let mut chunks = Vec::new();

    for line in backend_events
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let event: StoredCaptureEvent = serde_json::from_str(line)
            .map_err(|error| format!("Failed to parse capture event line: {}", error))?;

        match event.event_type.as_str() {
            "pty_chunk" => {
                let seq = event
                    .data
                    .get("seq")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "Capture PTY chunk missing seq".to_string())?;
                let data_base64 = event
                    .data
                    .get("data_base64")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Capture PTY chunk missing data_base64".to_string())?
                    .to_string();

                chunks.push(CodexCaptureReplayChunk::Pty {
                    seq,
                    timestamp_ms: event.timestamp_ms,
                    data_base64,
                });
            }
            "system_chunk" => {
                let seq = event
                    .data
                    .get("seq")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "Capture system chunk missing seq".to_string())?;
                let text = event
                    .data
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Capture system chunk missing text".to_string())?
                    .to_string();

                chunks.push(CodexCaptureReplayChunk::System {
                    seq,
                    timestamp_ms: event.timestamp_ms,
                    text,
                });
            }
            _ => {}
        }
    }

    Ok(chunks)
}

#[cfg(debug_assertions)]
fn debug_log(message: impl AsRef<str>) {
    eprintln!("[codex-debug] {}", message.as_ref());
}

#[cfg(not(debug_assertions))]
fn debug_log(_message: impl AsRef<str>) {}

fn build_pty_chunk_payload(session_id: &str, seq: u64, encoded: String) -> TerminalChunkPayload {
    TerminalChunkPayload::Pty {
        session_id: session_id.to_string(),
        seq,
        data_base64: encoded,
    }
}

fn build_system_chunk_payload(session_id: &str, seq: u64, text: String) -> TerminalChunkPayload {
    TerminalChunkPayload::System {
        session_id: session_id.to_string(),
        seq,
        text,
    }
}

fn emit_pty_chunk(app: &AppHandle, session_id: &str, session: &CodexSession, bytes: Vec<u8>) {
    let seq = session.next_seq();
    let encoded = BASE64_STANDARD.encode(&bytes);
    debug_log(format!(
        "pty emit session={} seq={} bytes={} ts_ms={}",
        session_id,
        seq,
        bytes.len(),
        now_unix_ms()
    ));

    if let Some(capture_bundle) = &session.capture_bundle {
        capture_bundle.write_backend_event(
            "pty_chunk",
            json!({
                "seq": seq,
                "byte_length": bytes.len(),
                "data_base64": encoded,
            }),
        );
    }

    let _ = app.emit(
        TERMINAL_CHUNK_EVENT,
        build_pty_chunk_payload(session_id, seq, BASE64_STANDARD.encode(&bytes)),
    );
}

fn emit_system_chunk(app: &AppHandle, session_id: &str, session: &CodexSession, text: String) {
    let seq = session.next_seq();
    debug_log(format!(
        "system emit session={} seq={} bytes={} ts_ms={}",
        session_id,
        seq,
        text.len(),
        now_unix_ms()
    ));

    if let Some(capture_bundle) = &session.capture_bundle {
        capture_bundle.write_backend_event(
            "system_chunk",
            json!({
                "seq": seq,
                "text": text,
            }),
        );
    }

    let _ = app.emit(
        TERMINAL_CHUNK_EVENT,
        build_system_chunk_payload(session_id, seq, text),
    );
}

fn emit_terminal_exit(
    app: &AppHandle,
    session_id: &str,
    code: Option<i32>,
    capture_bundle_path: Option<String>,
) {
    debug_log(format!(
        "exit session={} code={:?} ts_ms={}",
        session_id,
        code,
        now_unix_ms()
    ));

    let payload = TerminalExitPayload {
        session_id: session_id.to_string(),
        code,
        capture_bundle_path,
    };

    let _ = app.emit(TERMINAL_EXIT_EVENT, payload);
}

fn should_flush_pty_batch(pending_len: usize, next_len: usize, elapsed: Duration) -> bool {
    pending_len > 0
        && (pending_len + next_len > MAX_PTY_BATCH_BYTES || elapsed >= MAX_PTY_BATCH_DELAY)
}

fn spawn_stream_reader(
    app: AppHandle,
    session_id: String,
    session: Arc<CodexSession>,
    mut reader: Box<dyn Read + Send>,
) {
    let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>();

    let reader_session_id = session_id.clone();
    let reader_session = Arc::clone(&session);
    let reader_app = app.clone();
    thread::spawn(move || {
        let mut bytes = [0_u8; 4096];

        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(read_len) => {
                    if chunk_tx.send(bytes[..read_len].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    emit_system_chunk(
                        &reader_app,
                        &reader_session_id,
                        reader_session.as_ref(),
                        format!("\n[system] Failed reading terminal stream: {}\n", error),
                    );
                    break;
                }
            }
        }
    });

    thread::spawn(move || {
        let mut pending = Vec::with_capacity(MAX_PTY_BATCH_BYTES);
        let mut batch_started_at: Option<Instant> = None;

        loop {
            let recv_result = match batch_started_at {
                Some(started_at) => {
                    let elapsed = started_at.elapsed();
                    if elapsed >= MAX_PTY_BATCH_DELAY {
                        if !pending.is_empty() {
                            emit_pty_chunk(
                                &app,
                                &session_id,
                                session.as_ref(),
                                std::mem::take(&mut pending),
                            );
                        }
                        batch_started_at = None;
                        continue;
                    }

                    chunk_rx.recv_timeout(MAX_PTY_BATCH_DELAY - elapsed)
                }
                None => match chunk_rx.recv() {
                    Ok(chunk) => Ok(chunk),
                    Err(_) => break,
                },
            };

            match recv_result {
                Ok(chunk) => {
                    if pending.is_empty() {
                        batch_started_at = Some(Instant::now());
                    } else if should_flush_pty_batch(
                        pending.len(),
                        chunk.len(),
                        batch_started_at
                            .map(|started_at| started_at.elapsed())
                            .unwrap_or_default(),
                    ) {
                        emit_pty_chunk(
                            &app,
                            &session_id,
                            session.as_ref(),
                            std::mem::take(&mut pending),
                        );
                        batch_started_at = Some(Instant::now());
                    }

                    pending.extend_from_slice(&chunk);

                    if pending.len() >= MAX_PTY_BATCH_BYTES {
                        emit_pty_chunk(
                            &app,
                            &session_id,
                            session.as_ref(),
                            std::mem::take(&mut pending),
                        );
                        batch_started_at = None;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        emit_pty_chunk(
                            &app,
                            &session_id,
                            session.as_ref(),
                            std::mem::take(&mut pending),
                        );
                    }
                    batch_started_at = None;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        if !pending.is_empty() {
            emit_pty_chunk(&app, &session_id, session.as_ref(), pending);
        }
    });
}

fn spawn_exit_watcher(
    app: AppHandle,
    state: Arc<Mutex<HashMap<String, Arc<CodexSession>>>>,
    session_id: String,
    session: Arc<CodexSession>,
) {
    thread::spawn(move || {
        let exit_code = {
            let mut child_guard = match session.child.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    emit_system_chunk(
                        &app,
                        &session_id,
                        session.as_ref(),
                        "\n[system] Failed to access process state (lock poisoned).\n".to_string(),
                    );
                    emit_terminal_exit(&app, &session_id, None, session.capture_path());
                    if let Ok(mut sessions) = state.lock() {
                        sessions.remove(&session_id);
                    }
                    return;
                }
            };

            match child_guard.wait() {
                Ok(status) => Some(status.exit_code() as i32),
                Err(error) => {
                    emit_system_chunk(
                        &app,
                        &session_id,
                        session.as_ref(),
                        format!("\n[system] Failed waiting on process exit: {}\n", error),
                    );
                    None
                }
            }
        };

        if let Some(capture_bundle) = &session.capture_bundle {
            capture_bundle.write_backend_event(
                "process_exit",
                json!({
                    "exit_code": exit_code,
                }),
            );
        }

        emit_terminal_exit(&app, &session_id, exit_code, session.capture_path());
        if let Ok(mut sessions) = state.lock() {
            sessions.remove(&session_id);
        }
    });
}

#[tauri::command]
pub fn get_terminal_host_info() -> TerminalHostInfoResponse {
    #[cfg(target_os = "windows")]
    {
        return TerminalHostInfoResponse {
            windows_pty: Some(WindowsPtyInfoResponse {
                backend: "conpty".to_string(),
                build_number: detect_windows_build_number(),
            }),
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        TerminalHostInfoResponse { windows_pty: None }
    }
}

#[tauri::command]
pub fn list_codex_capture_bundles(
    request: ListCodexCaptureBundlesRequest,
) -> Result<Vec<CodexCaptureBundleListItem>, String> {
    let capture_root = Path::new(&request.workspace_path)
        .join(".skala")
        .join("codex-captures");

    if !capture_root.exists() {
        return Ok(Vec::new());
    }

    let mut bundles = fs::read_dir(&capture_root)
        .map_err(|error| {
            format!(
                "Failed to read capture directory '{}': {}",
                capture_root.display(),
                error
            )
        })?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let bundle_dir = entry.path();
            if !bundle_dir.is_dir() {
                return None;
            }

            let manifest = read_capture_manifest(&bundle_dir).ok()?;
            Some(CodexCaptureBundleListItem {
                path: bundle_dir.to_string_lossy().to_string(),
                session_id: manifest.session_id,
                created_at_ms: manifest.created_at_ms,
                command_line: manifest.command_line,
            })
        })
        .collect::<Vec<_>>();

    bundles.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms));
    Ok(bundles)
}

#[tauri::command]
pub fn load_codex_capture_bundle(
    request: LoadCodexCaptureBundleRequest,
) -> Result<LoadCodexCaptureBundleResponse, String> {
    let bundle_dir = PathBuf::from(&request.bundle_path);
    let manifest = read_capture_manifest(&bundle_dir)?;
    let chunks = read_capture_replay_chunks(&bundle_dir)?;

    Ok(LoadCodexCaptureBundleResponse { manifest, chunks })
}

#[tauri::command]
pub fn spawn_codex_process(
    app: AppHandle,
    state: State<CodexSessionState>,
    request: SpawnCodexProcessRequest,
) -> Result<SpawnCodexProcessResponse, String> {
    let request_args = request.args.clone().unwrap_or_default();
    let attempts = build_spawn_attempts(&request.command, &request_args);

    let pty_system = native_pty_system();

    let mut spawn_errors = Vec::new();
    let mut spawn_result = None;

    for attempt in attempts {
        let pty_pair = match pty_system.openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(error) => {
                return Err(format!("Failed to create terminal: {}", error));
            }
        };

        let portable_pty::PtyPair { master, slave } = pty_pair;
        let master = master;

        let mut command_builder = CommandBuilder::new(&attempt.program);
        command_builder.cwd(&request.workspace_path);
        command_builder.env("TERM", "xterm-256color");
        for arg in &attempt.args {
            command_builder.arg(arg);
        }

        match slave.spawn_command(command_builder) {
            Ok(child) => {
                let reader = match master.try_clone_reader() {
                    Ok(reader) => reader,
                    Err(error) => {
                        spawn_errors.push(format!(
                            "{} -> failed to attach terminal reader: {}",
                            attempt.display, error
                        ));
                        continue;
                    }
                };

                let writer = match master.take_writer() {
                    Ok(writer) => writer,
                    Err(error) => {
                        spawn_errors.push(format!(
                            "{} -> failed to attach terminal writer: {}",
                            attempt.display, error
                        ));
                        continue;
                    }
                };

                spawn_result = Some((child, reader, writer, master, attempt.display, attempt.args));
                break;
            }
            Err(error) => {
                spawn_errors.push(format!("{} -> {}", attempt.display, error));
            }
        }
    }

    let (child, reader, writer, master, command_line, spawned_args) =
        spawn_result.ok_or_else(|| {
            let attempts_copy = if spawn_errors.is_empty() {
                "  - (no attempts were constructed)".to_string()
            } else {
                spawn_errors
                    .iter()
                    .map(|error| format!("  - {}", error))
                    .collect::<Vec<_>>()
                    .join("\n")
            };

            format!(
                "Failed to spawn Codex in '{}'. Tried:\n{}",
                request.workspace_path, attempts_copy
            )
        })?;

    let session_id = format!("codex-{}", Uuid::new_v4());
    let capture_bundle = if request.capture_debug_bundle.unwrap_or(false) {
        Some(DebugCaptureBundle::create(
            &request.workspace_path,
            &session_id,
            &command_line,
            &spawned_args,
        )?)
    } else {
        None
    };
    let capture_bundle_path = capture_bundle.as_ref().map(DebugCaptureBundle::path_string);

    let session = Arc::new(CodexSession::new(
        child,
        Some(writer),
        master,
        capture_bundle,
    ));
    state.insert(session_id.clone(), Arc::clone(&session))?;

    if let Some(capture_bundle) = &session.capture_bundle {
        capture_bundle.write_backend_event(
            "session_started",
            json!({
                "workspace_path": request.workspace_path,
                "command_line": command_line,
            }),
        );
    }

    spawn_stream_reader(
        app.clone(),
        session_id.clone(),
        Arc::clone(&session),
        reader,
    );

    spawn_exit_watcher(
        app.clone(),
        Arc::clone(&state.sessions),
        session_id.clone(),
        Arc::clone(&session),
    );

    let message = format!(
        "Codex process started with '{}' in workspace '{}'.",
        command_line, request.workspace_path
    );

    emit_system_chunk(
        &app,
        &session_id,
        session.as_ref(),
        format!("\n[system] {}\n", message),
    );

    Ok(SpawnCodexProcessResponse {
        session_id,
        status: "running".to_string(),
        message,
        capture_bundle_path,
    })
}

#[tauri::command]
pub fn record_codex_capture_events(
    state: State<CodexSessionState>,
    request: RecordCodexCaptureEventsRequest,
) -> Result<OperationAck, String> {
    let Some(session) = state.get(&request.session_id)? else {
        return Ok(OperationAck {
            ok: true,
            message: format!(
                "Session '{}' is already stopped or does not exist.",
                request.session_id
            ),
        });
    };

    let Some(capture_bundle) = &session.capture_bundle else {
        return Ok(OperationAck {
            ok: true,
            message: format!(
                "Debug capture is not enabled for session '{}'.",
                request.session_id
            ),
        });
    };

    for event in request.events {
        capture_bundle.write_frontend_event(&event.event_type, event.data);
    }

    Ok(OperationAck {
        ok: true,
        message: format!(
            "Recorded capture events for session '{}'.",
            request.session_id
        ),
    })
}

#[tauri::command]
pub fn send_codex_input(
    state: State<CodexSessionState>,
    request: SendCodexInputRequest,
) -> Result<OperationAck, String> {
    let session = state
        .get(&request.session_id)?
        .ok_or_else(|| format!("No active session '{}'", request.session_id))?;

    let mut writer_guard = session
        .writer
        .lock()
        .map_err(|_| "codex stdin lock poisoned".to_string())?;

    let writer = writer_guard.as_mut().ok_or_else(|| {
        format!(
            "Session '{}' has no writable terminal input",
            request.session_id
        )
    })?;

    writer
        .write_all(request.input.as_bytes())
        .map_err(|error| {
            format!(
                "Failed to write to session '{}': {}",
                request.session_id, error
            )
        })?;

    writer.flush().map_err(|error| {
        format!(
            "Failed to flush input for session '{}': {}",
            request.session_id, error
        )
    })?;

    if let Some(capture_bundle) = &session.capture_bundle {
        capture_bundle.write_backend_event(
            "input_forwarded",
            json!({
                "byte_length": request.input.as_bytes().len(),
                "input_base64": BASE64_STANDARD.encode(request.input.as_bytes()),
            }),
        );
    }

    Ok(OperationAck {
        ok: true,
        message: format!("Input forwarded to session '{}'.", request.session_id),
    })
}

#[tauri::command]
pub fn stop_codex_process(
    state: State<CodexSessionState>,
    request: StopCodexProcessRequest,
) -> Result<OperationAck, String> {
    let Some(session) = state.get(&request.session_id)? else {
        return Ok(OperationAck {
            ok: true,
            message: format!(
                "Session '{}' is already stopped or does not exist.",
                request.session_id
            ),
        });
    };

    if let Some(capture_bundle) = &session.capture_bundle {
        capture_bundle.write_backend_event("stop_requested", json!({}));
    }

    if let Ok(mut writer_guard) = session.writer.lock() {
        writer_guard.take();
    }

    let mut child_guard = session
        .child
        .lock()
        .map_err(|_| "codex process lock poisoned".to_string())?;

    match child_guard.kill() {
        Ok(()) => Ok(OperationAck {
            ok: true,
            message: format!("Stop requested for session '{}'.", request.session_id),
        }),
        Err(error) => Ok(OperationAck {
            ok: true,
            message: format!(
                "Stop requested for session '{}' (process may already have exited: {}).",
                request.session_id, error
            ),
        }),
    }
}

#[tauri::command]
pub fn resize_codex_terminal(
    state: State<CodexSessionState>,
    request: ResizeCodexTerminalRequest,
) -> Result<OperationAck, String> {
    let Some(session) = state.get(&request.session_id)? else {
        return Ok(OperationAck {
            ok: true,
            message: format!(
                "Session '{}' is already stopped or does not exist.",
                request.session_id
            ),
        });
    };

    let cols = request.cols.max(2);
    let rows = request.rows.max(2);

    let master_guard = session
        .master
        .lock()
        .map_err(|_| "codex pty master lock poisoned".to_string())?;

    master_guard
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| {
            format!(
                "Failed to resize session '{}': {}",
                request.session_id, error
            )
        })?;

    debug_log(format!(
        "resize session={} cols={} rows={} ts_ms={}",
        request.session_id,
        cols,
        rows,
        now_unix_ms()
    ));

    if let Some(capture_bundle) = &session.capture_bundle {
        capture_bundle.write_backend_event(
            "pty_resized",
            json!({
                "cols": cols,
                "rows": rows,
            }),
        );
    }

    Ok(OperationAck {
        ok: true,
        message: format!(
            "Resized session '{}' to {}x{}.",
            request.session_id, cols, rows
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_batch_flushes_on_size_or_time_boundaries() {
        assert!(!should_flush_pty_batch(
            1024,
            1024,
            Duration::from_millis(5)
        ));
        assert!(should_flush_pty_batch(8190, 4, Duration::from_millis(0)));
        assert!(should_flush_pty_batch(128, 64, Duration::from_millis(10)));
    }

    #[test]
    fn session_sequence_is_monotonic() {
        let sequence = SessionSequence::default();
        assert_eq!(sequence.next_seq(), 0);
        assert_eq!(sequence.next_seq(), 1);
        assert_eq!(sequence.next_seq(), 2);
    }

    #[test]
    fn pty_payload_is_base64_encoded_with_seq() {
        let payload = build_pty_chunk_payload("codex-session", 7, "YWJjDQo=".to_string());

        match payload {
            TerminalChunkPayload::Pty {
                session_id,
                seq,
                data_base64,
            } => {
                assert_eq!(session_id, "codex-session");
                assert_eq!(seq, 7);
                assert_eq!(data_base64, "YWJjDQo=");
            }
            TerminalChunkPayload::System { .. } => panic!("expected PTY payload"),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn build_spawn_attempts_prefers_direct_codex_executables_before_cmd_wrappers() {
        let attempts = build_spawn_attempts("codex", &[]);
        let exe_index = attempts
            .iter()
            .position(|attempt| attempt.display.contains("codex.exe"))
            .expect("expected codex.exe candidate");
        let cmd_index = attempts
            .iter()
            .position(|attempt| attempt.display.contains("codex.cmd"))
            .expect("expected codex.cmd candidate");

        assert!(exe_index < cmd_index);
    }
}
