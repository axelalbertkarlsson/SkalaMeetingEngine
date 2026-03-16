use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingRunType {
    MeetingImport,
    MeetingRecording,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingRunStatus {
    Capturing,
    Imported,
    QueuedForTranscription,
    Transcribing,
    Cleaning,
    NeedsReview,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    RawRecording,
    RawTranscript,
    CleanedTranscript,
    ProviderResponse,
    TerminalLog,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingSource {
    Microphone,
    SystemAudio,
    Mixed,
    ImportedFile,
}

impl RecordingSource {
    pub fn as_label(&self) -> &'static str {
        match self {
            Self::Microphone => "Microphone",
            Self::SystemAudio => "System audio",
            Self::Mixed => "Mixed input",
            Self::ImportedFile => "Imported file",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub run_id: String,
    pub kind: ArtifactKind,
    pub path: String,
    pub created_at: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRunRecord {
    pub id: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub title: String,
    #[serde(rename = "type")]
    pub run_type: MeetingRunType,
    pub status: MeetingRunStatus,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub artifact_ids: Vec<String>,
    pub artifacts: Vec<ArtifactRecord>,
    pub summary: Option<String>,
    pub error_message: Option<String>,
    pub progress_label: Option<String>,
    pub recording_source: RecordingSource,
    pub input_path: Option<String>,
}

impl MeetingRunRecord {
    pub fn new(
        workspace_id: String,
        workspace_root: String,
        title: String,
        run_type: MeetingRunType,
        status: MeetingRunStatus,
        recording_source: RecordingSource,
    ) -> Self {
        Self {
            id: format!("run-{}", Uuid::new_v4()),
            workspace_id,
            workspace_root,
            title,
            run_type,
            status,
            started_at: now_iso(),
            ended_at: None,
            artifact_ids: Vec::new(),
            artifacts: Vec::new(),
            summary: None,
            error_message: None,
            progress_label: None,
            recording_source,
            input_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSettings {
    pub open_ai_api_key: Option<String>,
    pub cleanup_model: String,
    pub ffmpeg_path: String,
    pub transcription_model: String,
    pub diarization_enabled: bool,
}

impl Default for TranscriptionSettings {
    fn default() -> Self {
        Self {
            open_ai_api_key: None,
            cleanup_model: "gpt-5-mini".to_string(),
            ffmpeg_path: "ffmpeg".to_string(),
            transcription_model: "gpt-4o-transcribe".to_string(),
            diarization_enabled: false,
        }
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
