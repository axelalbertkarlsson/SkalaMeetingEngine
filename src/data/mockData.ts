import type { Artifact, Run } from "../models/run";
import type { Workspace } from "../models/workspace";

export const workspaces: Workspace[] = [
  {
    id: "ws-01",
    name: "Dyve Product Workbench",
    rootPath: "C:/Users/AxelKarlsson/Dyve",
    status: "active",
    createdAt: "2026-03-01T09:00:00Z",
    tags: ["meetings", "product", "obsidian"],
    obsidian: {
      vaultPath: "C:/Users/AxelKarlsson/Documents/ObsidianVault",
      publishFolder: "Meetings/Inbox",
      safeMode: true
    }
  }
];

export const runs: Run[] = [
  {
    id: "run-1001",
    workspaceId: "ws-01",
    title: "Weekly product sync",
    type: "meeting_recording",
    status: "needs_review",
    startedAt: "2026-03-10T13:00:00Z",
    endedAt: "2026-03-10T13:52:00Z",
    artifactIds: ["artifact-01", "artifact-02"],
    summary: "Recording complete, transcript not yet generated."
  },
  {
    id: "run-1002",
    workspaceId: "ws-01",
    title: "Q2 planning import",
    type: "meeting_import",
    status: "running",
    startedAt: "2026-03-11T08:15:00Z",
    artifactIds: ["artifact-03"],
    summary: "Imported media and queued transcription stub."
  },
  {
    id: "run-1003",
    workspaceId: "ws-01",
    title: "Codex follow-up session",
    type: "codex_session",
    status: "completed",
    startedAt: "2026-03-09T16:10:00Z",
    endedAt: "2026-03-09T16:40:00Z",
    artifactIds: ["artifact-04"]
  }
];

export const artifacts: Artifact[] = [
  {
    id: "artifact-01",
    runId: "run-1001",
    kind: "raw_recording",
    path: "artifacts/run-1001/recording.wav",
    createdAt: "2026-03-10T13:53:00Z"
  },
  {
    id: "artifact-02",
    runId: "run-1001",
    kind: "terminal_log",
    path: "artifacts/run-1001/recording.log",
    createdAt: "2026-03-10T13:53:10Z"
  },
  {
    id: "artifact-03",
    runId: "run-1002",
    kind: "raw_recording",
    path: "artifacts/run-1002/imported_audio.mp3",
    createdAt: "2026-03-11T08:16:00Z"
  },
  {
    id: "artifact-04",
    runId: "run-1003",
    kind: "terminal_log",
    path: "artifacts/run-1003/codex.log",
    createdAt: "2026-03-09T16:40:20Z"
  }
];
