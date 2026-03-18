export type RunType =
  | "meeting_import"
  | "meeting_recording"
  | "transcription"
  | "note_generation"
  | "codex_session";

export type RunStatus =
  | "queued"
  | "running"
  | "capturing"
  | "source_ready"
  | "imported"
  | "queued_for_transcription"
  | "transcribing"
  | "cleaning"
  | "needs_review"
  | "completed"
  | "failed";

export type ArtifactKind =
  | "raw_recording"
  | "raw_transcript"
  | "cleaned_transcript"
  | "provider_response"
  | "structured_extraction"
  | "obsidian_preview"
  | "publish_log"
  | "terminal_log";

export type RecordingSource = "microphone" | "system_audio" | "mixed" | "imported_file";
export type MeetingArtifactContentType = "markdown" | "text" | "json";

export interface Artifact {
  id: string;
  runId: string;
  kind: ArtifactKind;
  path: string;
  createdAt: string;
  label?: string;
}

export interface MeetingArtifactContent {
  kind: ArtifactKind;
  path: string;
  content: string;
  contentType: MeetingArtifactContentType;
}

export interface Run {
  id: string;
  workspaceId: string;
  workspaceRoot?: string;
  title: string;
  type: RunType;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  artifactIds: string[];
  artifacts?: Artifact[];
  summary?: string;
  errorMessage?: string;
  progressLabel?: string;
  recordingSource?: RecordingSource;
  inputPath?: string;
}
