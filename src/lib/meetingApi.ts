import { invoke } from "@tauri-apps/api/core";
import type { ArtifactKind, MeetingArtifactContent, RecordingSource, Run } from "../models/run";

export interface TranscriptionSettings {
  openAiApiKey?: string;
  cleanupModel: string;
  ffmpegPath: string;
  transcriptionModel: string;
  diarizationEnabled: boolean;
}

interface WorkspaceRef {
  workspaceId: string;
  workspaceRoot: string;
}

interface RecordingJobResponse {
  recordingJobId: string;
  status: string;
  message: string;
  run: Run;
}

function mapRun(run: any): Run {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    workspaceRoot: run.workspaceRoot,
    title: run.title,
    type: run.type,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    artifactIds: run.artifactIds ?? [],
    artifacts: (run.artifacts ?? []).map((artifact: any) => ({
      id: artifact.id,
      runId: artifact.runId,
      kind: artifact.kind,
      path: artifact.path,
      createdAt: artifact.createdAt,
      label: artifact.label
    })),
    summary: run.summary,
    errorMessage: run.errorMessage,
    progressLabel: run.progressLabel,
    recordingSource: run.recordingSource,
    inputPath: run.inputPath
  };
}

export async function listMeetingRuns(workspace: WorkspaceRef): Promise<Run[]> {
  const runs = await invoke<any[]>("list_meeting_runs", { request: workspace });
  return runs.map(mapRun);
}

export async function importMeetingFile(
  workspace: WorkspaceRef,
  meetingTitle: string,
  file: File
): Promise<Run> {
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  const run = await invoke<any>("import_meeting_file", {
    request: {
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.workspaceRoot,
      meetingTitle,
      fileName: file.name,
      fileBytes: bytes
    }
  });
  return mapRun(run);
}

export async function startRecording(
  workspace: WorkspaceRef,
  meetingTitle: string,
  source: RecordingSource
): Promise<RecordingJobResponse> {
  const response = await invoke<any>("start_recording", {
    request: {
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.workspaceRoot,
      meetingTitle,
      source
    }
  });
  return {
    recordingJobId: response.recordingJobId,
    status: response.status,
    message: response.message,
    run: mapRun(response.run)
  };
}

export async function stopRecording(recordingJobId: string): Promise<void> {
  await invoke("stop_recording", {
    request: {
      recordingJobId
    }
  });
}

export async function retranscribeMeetingRun(workspaceRoot: string, runId: string): Promise<Run> {
  const run = await invoke<any>("retranscribe_meeting_run", {
    request: {
      workspaceRoot,
      runId
    }
  });
  return mapRun(run);
}

export async function readMeetingArtifact(
  workspaceRoot: string,
  runId: string,
  kind: ArtifactKind
): Promise<MeetingArtifactContent> {
  const artifact = await invoke<any>("read_meeting_artifact", {
    request: {
      workspaceRoot,
      runId,
      kind
    }
  });

  return {
    kind: artifact.kind,
    path: artifact.path,
    content: artifact.content,
    contentType: artifact.contentType
  };
}

export async function deleteMeetingTranscripts(workspaceRoot: string, runId: string): Promise<void> {
  await invoke("delete_meeting_transcripts", {
    request: {
      workspaceRoot,
      runId
    }
  });
}

export async function deleteMeetingRun(workspaceRoot: string, runId: string): Promise<void> {
  await invoke("delete_meeting_run", {
    request: {
      workspaceRoot,
      runId
    }
  });
}

export async function openMeetingArtifactLocation(path: string): Promise<void> {
  await invoke("open_meeting_artifact_location", {
    request: {
      path
    }
  });
}

export async function getTranscriptionSettings(): Promise<TranscriptionSettings> {
  const settings = await invoke<any>("get_transcription_settings");
  return {
    openAiApiKey: settings.openAiApiKey,
    cleanupModel: settings.cleanupModel,
    ffmpegPath: settings.ffmpegPath,
    transcriptionModel: settings.transcriptionModel,
    diarizationEnabled: Boolean(settings.diarizationEnabled)
  };
}

export async function saveTranscriptionSettings(
  settings: Partial<TranscriptionSettings>
): Promise<TranscriptionSettings> {
  const result = await invoke<any>("save_transcription_settings", {
    request: {
      openAiApiKey: settings.openAiApiKey,
      cleanupModel: settings.cleanupModel,
      ffmpegPath: settings.ffmpegPath,
      diarizationEnabled: settings.diarizationEnabled
    }
  });
  return {
    openAiApiKey: result.openAiApiKey,
    cleanupModel: result.cleanupModel,
    ffmpegPath: result.ffmpegPath,
    transcriptionModel: result.transcriptionModel,
    diarizationEnabled: Boolean(result.diarizationEnabled)
  };
}

