use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{BufReader, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::types::OperationAck;

const TERMINAL_CHUNK_EVENT: &str = "codex://terminal-chunk";
const TERMINAL_EXIT_EVENT: &str = "codex://terminal-exit";

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

struct CodexSession {
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    _master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
}

impl CodexSession {
    fn new(
        child: Box<dyn portable_pty::Child + Send>,
        writer: Option<Box<dyn Write + Send>>,
        master: Box<dyn portable_pty::MasterPty + Send>,
    ) -> Self {
        Self {
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            _master: Mutex::new(master),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SpawnCodexProcessRequest {
    pub workspace_path: String,
    pub command: String,
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct SpawnCodexProcessResponse {
    pub session_id: String,
    pub status: String,
    pub message: String,
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

#[derive(Debug, Serialize, Clone)]
struct TerminalChunkPayload {
    session_id: String,
    stream: String,
    chunk: String,
}

#[derive(Debug, Serialize, Clone)]
struct TerminalExitPayload {
    session_id: String,
    code: Option<i32>,
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

fn build_spawn_attempts(command: &str, request_args: &[String]) -> Vec<SpawnAttempt> {
    let trimmed = command.trim();
    let normalized = if trimmed.is_empty() { "codex" } else { trimmed };

    let mut attempts = vec![make_spawn_attempt(normalized, request_args)];

    #[cfg(target_os = "windows")]
    {
        if normalized.eq_ignore_ascii_case("codex") {
            attempts.push(make_spawn_attempt("codex.cmd", request_args));
            attempts.push(make_spawn_attempt("codex.exe", request_args));

            if let Ok(app_data) = env::var("APPDATA") {
                let npm_dir = Path::new(&app_data).join("npm");

                let cmd_candidate = npm_dir.join("codex.cmd").to_string_lossy().to_string();
                attempts.push(make_spawn_attempt(&cmd_candidate, request_args));

                let ps1_candidate = npm_dir.join("codex.ps1").to_string_lossy().to_string();
                attempts.push(make_spawn_attempt(&ps1_candidate, request_args));
            }
        }
    }

    let mut deduped = Vec::with_capacity(attempts.len());
    let mut seen = HashSet::with_capacity(attempts.len());
    for attempt in attempts {
        let key = format!("{}|{}", attempt.program, attempt.args.join("\u{001F}"));
        if seen.insert(key) {
            deduped.push(attempt);
        }
    }

    deduped
}

fn emit_terminal_chunk(app: &AppHandle, session_id: &str, stream: &str, chunk: String) {
    let payload = TerminalChunkPayload {
        session_id: session_id.to_string(),
        stream: stream.to_string(),
        chunk,
    };

    let _ = app.emit(TERMINAL_CHUNK_EVENT, payload);
}

fn emit_terminal_exit(app: &AppHandle, session_id: &str, code: Option<i32>) {
    let payload = TerminalExitPayload {
        session_id: session_id.to_string(),
        code,
    };

    let _ = app.emit(TERMINAL_EXIT_EVENT, payload);
}

fn spawn_stream_reader<R: Read + Send + 'static>(
    app: AppHandle,
    session_id: String,
    stream: &'static str,
    reader: R,
) {
    thread::spawn(move || {
        let mut buffered = BufReader::new(reader);
        let mut bytes = [0_u8; 4096];

        loop {
            match buffered.read(&mut bytes) {
                Ok(0) => break,
                Ok(read_len) => {
                    let chunk = String::from_utf8_lossy(&bytes[..read_len]).to_string();
                    emit_terminal_chunk(&app, &session_id, stream, chunk);
                }
                Err(error) => {
                    emit_terminal_chunk(
                        &app,
                        &session_id,
                        "system",
                        format!("\n[system] Failed reading terminal stream: {}\n", error),
                    );
                    break;
                }
            }
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
                    emit_terminal_chunk(
                        &app,
                        &session_id,
                        "system",
                        "\n[system] Failed to access process state (lock poisoned).\n".to_string(),
                    );
                    emit_terminal_exit(&app, &session_id, None);
                    if let Ok(mut sessions) = state.lock() {
                        sessions.remove(&session_id);
                    }
                    return;
                }
            };

            match child_guard.wait() {
                Ok(status) => Some(status.exit_code() as i32),
                Err(error) => {
                    emit_terminal_chunk(
                        &app,
                        &session_id,
                        "system",
                        format!("\n[system] Failed waiting on process exit: {}\n", error),
                    );
                    None
                }
            }
        };

        emit_terminal_exit(&app, &session_id, exit_code);
        if let Ok(mut sessions) = state.lock() {
            sessions.remove(&session_id);
        }
    });
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

                spawn_result = Some((child, reader, writer, master, attempt.display));
                break;
            }
            Err(error) => {
                spawn_errors.push(format!("{} -> {}", attempt.display, error));
            }
        }
    }

    let (child, reader, writer, master, command_line) = spawn_result.ok_or_else(|| {
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

    let session = Arc::new(CodexSession::new(child, Some(writer), master));
    state.insert(session_id.clone(), Arc::clone(&session))?;

    spawn_stream_reader(app.clone(), session_id.clone(), "stdout", reader);

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

    emit_terminal_chunk(
        &app,
        &session_id,
        "system",
        format!("\n[system] {}\n", message),
    );

    Ok(SpawnCodexProcessResponse {
        session_id,
        status: "running".to_string(),
        message,
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
        ._master
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

    Ok(OperationAck {
        ok: true,
        message: format!(
            "Resized session '{}' to {}x{}.",
            request.session_id, cols, rows
        ),
    })
}
