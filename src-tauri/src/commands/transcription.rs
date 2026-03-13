use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionBackend {
    Openai,
    Easytranscriber,
    LocalWhisper,
}

#[derive(Debug, Deserialize)]
pub struct CreateTranscriptionJobRequest {
    pub run_id: String,
    pub input_path: String,
    pub backend: TranscriptionBackend,
}

#[derive(Debug, Serialize)]
pub struct CreateTranscriptionJobResponse {
    pub transcription_job_id: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct TranscriptionJobStatusResponse {
    pub transcription_job_id: String,
    pub status: String,
    pub message: String,
}

#[tauri::command]
pub fn create_transcription_job(
    request: CreateTranscriptionJobRequest,
) -> Result<CreateTranscriptionJobResponse, String> {
    let transcription_job_id = format!("tr-{}", Uuid::new_v4());

    Ok(CreateTranscriptionJobResponse {
        transcription_job_id: transcription_job_id.clone(),
        status: "stub_queued".to_string(),
        message: format!(
            "Transcription stub queued for run '{}' using {:?} on '{}'.",
            request.run_id, request.backend, request.input_path
        ),
    })
}

#[tauri::command]
pub fn get_transcription_job_status(
    job_id: String,
) -> Result<TranscriptionJobStatusResponse, String> {
    Ok(TranscriptionJobStatusResponse {
        transcription_job_id: job_id,
        status: "not_implemented".to_string(),
        message: "Status polling stub only. No provider calls are implemented yet.".to_string(),
    })
}
