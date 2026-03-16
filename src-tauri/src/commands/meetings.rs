use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

use crate::meetings::{
    models::{
        ArtifactKind, MeetingRunRecord, MeetingRunStatus, MeetingRunType, RecordingSource,
        TranscriptionSettings,
    },
    recorder::{self, RecordingSession},
    settings, store, transcription,
};

#[derive(Default)]
pub struct MeetingRuntimeState {
    pub recording_sessions: Mutex<HashMap<String, RecordingSession>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRequest {
    pub workspace_id: String,
    pub workspace_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMeetingFileRequest {
    pub workspace_id: String,
    pub workspace_root: String,
    pub meeting_title: String,
    pub file_name: String,
    pub file_bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingRequest {
    pub workspace_id: String,
    pub workspace_root: String,
    pub meeting_title: String,
    pub source: RecordingSource,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRecordingRequest {
    pub recording_job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMeetingRunRequest {
    pub workspace_root: String,
    pub run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryMeetingRunRequest {
    pub workspace_root: String,
    pub run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTranscriptionSettingsRequest {
    pub open_ai_api_key: Option<String>,
    pub cleanup_model: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub diarization_enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingJobResponse {
    pub recording_job_id: String,
    pub status: String,
    pub message: String,
    pub run: MeetingRunRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationAck {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub fn import_meeting_file(request: ImportMeetingFileRequest) -> Result<MeetingRunRecord, String> {
    let workspace_root = PathBuf::from(&request.workspace_root);
    let mut run = store::create_run(
        &request.workspace_id,
        &workspace_root,
        &request.meeting_title,
        MeetingRunType::MeetingImport,
        MeetingRunStatus::Imported,
        RecordingSource::ImportedFile,
    )
    .map_err(|error| error.to_string())?;

    let input_path = store::write_input_bytes(
        &workspace_root,
        &run.id,
        &request.file_name,
        &request.file_bytes,
    )
    .map_err(|error| error.to_string())?;
    run.input_path = Some(input_path.to_string_lossy().to_string());
    run.summary = Some("Imported media and queued transcription.".to_string());
    run.progress_label = Some("Imported file".to_string());
    store::add_artifact(
        &mut run,
        ArtifactKind::RawRecording,
        input_path.to_string_lossy().to_string(),
        Some("Imported media".to_string()),
    );
    store::save_run(&run).map_err(|error| error.to_string())?;
    queue_transcription(&workspace_root, &run.id).map_err(|error| error.to_string())?;
    store::load_run(&workspace_root, &run.id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn start_recording(
    request: StartRecordingRequest,
    state: tauri::State<'_, MeetingRuntimeState>,
) -> Result<RecordingJobResponse, String> {
    let workspace_root = PathBuf::from(&request.workspace_root);
    let settings = settings::load_settings().map_err(|error| error.to_string())?;
    let mut run = store::create_run(
        &request.workspace_id,
        &workspace_root,
        &request.meeting_title,
        MeetingRunType::MeetingRecording,
        MeetingRunStatus::Capturing,
        request.source.clone(),
    )
    .map_err(|error| error.to_string())?;

    let (session, output_path, log_path) = recorder::spawn_recording(
        &settings.ffmpeg_path,
        &workspace_root,
        &run.id,
        &request.source,
    )
    .map_err(|error| error.to_string())?;

    run.input_path = Some(output_path.to_string_lossy().to_string());
    run.summary = Some("Recording in progress.".to_string());
    run.progress_label = Some("Capturing audio".to_string());
    store::add_artifact(
        &mut run,
        ArtifactKind::RawRecording,
        output_path.to_string_lossy().to_string(),
        Some("Recording output".to_string()),
    );
    store::add_artifact(
        &mut run,
        ArtifactKind::TerminalLog,
        log_path.to_string_lossy().to_string(),
        Some("Recording log".to_string()),
    );
    store::save_run(&run).map_err(|error| error.to_string())?;

    state
        .recording_sessions
        .lock()
        .map_err(|_| "Failed to access active recording sessions.".to_string())?
        .insert(run.id.clone(), session);

    Ok(RecordingJobResponse {
        recording_job_id: run.id.clone(),
        status: "capturing".to_string(),
        message: format!("Recording started for '{}'.", run.title),
        run,
    })
}

#[tauri::command]
pub fn stop_recording(
    request: StopRecordingRequest,
    state: tauri::State<'_, MeetingRuntimeState>,
) -> Result<OperationAck, String> {
    let mut sessions = state
        .recording_sessions
        .lock()
        .map_err(|_| "Failed to access active recording sessions.".to_string())?;
    let mut session = sessions.remove(&request.recording_job_id).ok_or_else(|| {
        format!(
            "No active recording session found for '{}'.",
            request.recording_job_id
        )
    })?;
    drop(sessions);

    recorder::stop_recording(&mut session).map_err(|error| error.to_string())?;

    let workspace_root = PathBuf::from(&session.workspace_root);
    let mut run =
        store::load_run(&workspace_root, &session.run_id).map_err(|error| error.to_string())?;
    run.summary = Some("Recording complete. Transcription queued.".to_string());
    run.progress_label = Some("Recording stopped".to_string());
    store::save_run(&run).map_err(|error| error.to_string())?;
    queue_transcription(&workspace_root, &run.id).map_err(|error| error.to_string())?;

    Ok(OperationAck {
        ok: true,
        message: format!(
            "Recording stopped for '{}'. Transcription queued.",
            run.title
        ),
    })
}

#[tauri::command]
pub fn list_meeting_runs(request: WorkspaceRequest) -> Result<Vec<MeetingRunRecord>, String> {
    store::list_runs(Path::new(&request.workspace_root), &request.workspace_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_meeting_run(request: GetMeetingRunRequest) -> Result<MeetingRunRecord, String> {
    store::load_run(Path::new(&request.workspace_root), &request.run_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn retry_meeting_run(request: RetryMeetingRunRequest) -> Result<MeetingRunRecord, String> {
    let workspace_root = PathBuf::from(&request.workspace_root);
    let mut run =
        store::load_run(&workspace_root, &request.run_id).map_err(|error| error.to_string())?;
    run.error_message = None;
    run.ended_at = None;
    store::save_run(&run).map_err(|error| error.to_string())?;
    queue_transcription(&workspace_root, &run.id).map_err(|error| error.to_string())?;
    store::load_run(&workspace_root, &run.id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_transcription_settings() -> Result<TranscriptionSettings, String> {
    settings::load_settings().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_transcription_settings(
    request: SaveTranscriptionSettingsRequest,
) -> Result<TranscriptionSettings, String> {
    let mut settings_value = settings::load_settings().map_err(|error| error.to_string())?;
    if let Some(open_ai_api_key) = request.open_ai_api_key {
        let trimmed = open_ai_api_key.trim().to_string();
        settings_value.open_ai_api_key = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
    if let Some(cleanup_model) = request
        .cleanup_model
        .filter(|value| !value.trim().is_empty())
    {
        settings_value.cleanup_model = cleanup_model.trim().to_string();
    }
    if let Some(ffmpeg_path) = request.ffmpeg_path.filter(|value| !value.trim().is_empty()) {
        settings_value.ffmpeg_path = ffmpeg_path.trim().to_string();
    }
    if let Some(diarization_enabled) = request.diarization_enabled {
        settings_value.diarization_enabled = diarization_enabled;
    }
    settings::save_settings(&settings_value).map_err(|error| error.to_string())
}

fn queue_transcription(workspace_root: &Path, run_id: &str) -> anyhow::Result<()> {
    let mut run = store::load_run(workspace_root, run_id)?;
    run.status = MeetingRunStatus::QueuedForTranscription;
    run.error_message = None;
    run.progress_label = Some("Queued for transcription".to_string());
    store::save_run(&run)?;
    transcription::enqueue_transcription(workspace_root.to_path_buf(), run_id.to_string());
    Ok(())
}
