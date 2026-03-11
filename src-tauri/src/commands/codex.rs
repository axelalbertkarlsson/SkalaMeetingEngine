use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::commands::types::OperationAck;

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

#[tauri::command]
pub fn spawn_codex_process(request: SpawnCodexProcessRequest) -> Result<SpawnCodexProcessResponse, String> {
  let args = request.args.unwrap_or_default().join(" ");
  let command_line = if args.is_empty() {
    request.command.clone()
  } else {
    format!("{} {}", request.command, args)
  };

  Ok(SpawnCodexProcessResponse {
    session_id: format!("codex-{}", Uuid::new_v4()),
    status: "stub_spawned".to_string(),
    message: format!(
      "Codex process spawn stub accepted for '{}' in workspace '{}'.",
      command_line, request.workspace_path
    ),
  })
}

#[tauri::command]
pub fn send_codex_input(request: SendCodexInputRequest) -> Result<OperationAck, String> {
  Ok(OperationAck {
    ok: true,
    message: format!(
      "Input accepted for session '{}' ({} chars). Stub only.",
      request.session_id,
      request.input.chars().count()
    ),
  })
}

#[tauri::command]
pub fn stop_codex_process(session_id: String) -> Result<OperationAck, String> {
  Ok(OperationAck {
    ok: true,
    message: format!(
      "Stop requested for session '{}' (stub only, no spawned process yet).",
      session_id
    ),
  })
}
