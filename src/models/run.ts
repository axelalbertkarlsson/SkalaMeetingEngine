export type RunType =
  | "meeting_import"
  | "meeting_recording"
  | "transcription"
  | "note_generation"
  | "codex_session";

export type RunStatus = "queued" | "running" | "needs_review" | "completed" | "failed";

export type ArtifactKind =
  | "raw_recording"
  | "raw_transcript"
  | "cleaned_transcript"
  | "structured_extraction"
  | "obsidian_preview"
  | "publish_log"
  | "terminal_log";

export interface Artifact {
  id: string;
  runId: string;
  kind: ArtifactKind;
  path: string;
  createdAt: string;
}

export interface Run {
  id: string;
  workspaceId: string;
  title: string;
  type: RunType;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  artifactIds: string[];
  summary?: string;
}
