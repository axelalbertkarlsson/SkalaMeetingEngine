use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::commands::types::OperationAck;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingSource {
    Microphone,
    SystemAudio,
    Mixed,
    ImportedFile,
}

#[derive(Debug, Deserialize)]
pub struct StartRecordingRequest {
    pub workspace_id: String,
    pub meeting_title: String,
    pub source: RecordingSource,
    pub output_dir: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartRecordingResponse {
    pub recording_job_id: String,
    pub status: String,
    pub message: String,
}

#[tauri::command]
pub fn start_recording(request: StartRecordingRequest) -> Result<StartRecordingResponse, String> {
    let output_dir = request
        .output_dir
        .unwrap_or_else(|| "artifacts/pending".to_string());

    Ok(StartRecordingResponse {
        recording_job_id: format!("rec-{}", Uuid::new_v4()),
        status: "stub_created".to_string(),
        message: format!(
            "Recording stub accepted for '{}' in workspace '{}' (source: {:?}, output: {}).",
            request.meeting_title, request.workspace_id, request.source, output_dir
        ),
    })
}

#[tauri::command]
pub fn stop_recording(recording_job_id: String) -> Result<OperationAck, String> {
    Ok(OperationAck {
        ok: true,
        message: format!(
            "Recording job '{}' stop requested (stub only, no active capture backend yet).",
            recording_job_id
        ),
    })
}
