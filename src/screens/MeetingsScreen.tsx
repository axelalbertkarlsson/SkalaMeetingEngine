import { useMemo, useState } from "react";
import { PaneHeader } from "../components/shell/PaneHeader";
import type { RecordingSource, Run } from "../models/run";
import type { Workspace } from "../models/workspace";

interface MeetingsScreenProps {
  workspace: Workspace;
  runs: Run[];
  loading: boolean;
  actionMessage: string | null;
  onImportFile: (meetingTitle: string, file: File) => Promise<void>;
  onStartRecording: (meetingTitle: string, source: RecordingSource) => Promise<void>;
  onStopRecording: (runId: string) => Promise<void>;
  onRetryRun: (runId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const recordingOptions: Array<{ value: RecordingSource; label: string; hint: string }> = [
  { value: "microphone", label: "Microphone", hint: "Default microphone input" },
  { value: "system_audio", label: "System audio", hint: "Loopback-capable device required" },
  { value: "mixed", label: "Mixed", hint: "Microphone plus system audio" }
];

function isActiveMeetingRun(run: Run) {
  return ["capturing", "queued_for_transcription", "transcribing", "cleaning"].includes(run.status);
}

export function MeetingsScreen({
  workspace,
  runs,
  loading,
  actionMessage,
  onImportFile,
  onStartRecording,
  onStopRecording,
  onRetryRun,
  onRefresh
}: MeetingsScreenProps) {
  const [meetingTitle, setMeetingTitle] = useState("New meeting");
  const [recordingSource, setRecordingSource] = useState<RecordingSource>("microphone");
  const [selectedRunId, setSelectedRunId] = useState<string>(runs[0]?.id ?? "");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0],
    [runs, selectedRunId]
  );
  const activeRecording = runs.find((run) => run.status === "capturing");

  const handleImportChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setBusyAction("import");
    try {
      await onImportFile(meetingTitle.trim() || file.name, file);
      event.target.value = "";
    } finally {
      setBusyAction(null);
    }
  };

  const handleStartRecording = async () => {
    setBusyAction("record");
    try {
      await onStartRecording(meetingTitle.trim() || "New meeting", recordingSource);
    } finally {
      setBusyAction(null);
    }
  };

  const handleStopRecording = async () => {
    if (!activeRecording) {
      return;
    }
    setBusyAction("stop");
    try {
      await onStopRecording(activeRecording.id);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetry = async () => {
    if (!selectedRun) {
      return;
    }
    setBusyAction("retry");
    try {
      await onRetryRun(selectedRun.id);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="workspace-screen">
      <PaneHeader
        eyebrow="Meetings"
        title="Capture And Import"
        subtitle="Record or import a meeting, then let the app produce raw and cleaned transcripts for review."
      />

      <div className="split-layout">
        <article className="pane-block">
          <h3 className="block-title">New run</h3>
          <div className="meeting-form-grid">
            <label className="meeting-field">
              <span>Workspace</span>
              <input className="settings-text-input" type="text" value={workspace.name} disabled />
            </label>
            <label className="meeting-field">
              <span>Meeting title</span>
              <input
                className="settings-text-input"
                type="text"
                value={meetingTitle}
                onChange={(event) => setMeetingTitle(event.target.value)}
                placeholder="Weekly product sync"
              />
            </label>
          </div>

          <div className="meeting-action-grid">
            <div className="meeting-action-card">
              <h4>Import audio or video</h4>
              <p className="muted">Uploads the selected file into the workspace run folder and starts transcription.</p>
              <label className="meeting-file-button">
                <input
                  type="file"
                  accept="audio/*,video/*"
                  onChange={handleImportChange}
                  disabled={busyAction !== null}
                />
                <span>{busyAction === "import" ? "Importing..." : "Choose file"}</span>
              </label>
            </div>

            <div className="meeting-action-card">
              <h4>Live recording</h4>
              <p className="muted">Windows-first FFmpeg capture. System audio depends on a loopback-capable device.</p>
              <div className="meeting-source-grid">
                {recordingOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={recordingSource === option.value ? "meeting-source-button active" : "meeting-source-button"}
                    onClick={() => setRecordingSource(option.value)}
                    disabled={busyAction !== null || Boolean(activeRecording)}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.hint}</span>
                  </button>
                ))}
              </div>
              <div className="meeting-button-row">
                <button
                  type="button"
                  className="codex-terminal-button"
                  onClick={handleStartRecording}
                  disabled={busyAction !== null || Boolean(activeRecording)}
                >
                  {busyAction === "record" ? "Starting..." : "Start recording"}
                </button>
                <button
                  type="button"
                  className="codex-terminal-button secondary"
                  onClick={handleStopRecording}
                  disabled={busyAction !== null || !activeRecording}
                >
                  {busyAction === "stop" ? "Stopping..." : "Stop recording"}
                </button>
              </div>
            </div>
          </div>

          <div className="meeting-inline-note muted">
            <span>Status:</span>
            <span>{loading ? "Refreshing runs..." : actionMessage ?? "Ready"}</span>
          </div>
        </article>

        <article className="pane-block">
          <div className="meeting-list-header">
            <h3 className="block-title">Meeting runs</h3>
            <button type="button" className="meeting-link-button" onClick={() => void onRefresh()}>
              Refresh
            </button>
          </div>
          <ul className="compact-list" role="list">
            {runs.map((run) => (
              <li
                key={run.id}
                className={run.id === selectedRun?.id ? "compact-row selected-row" : "compact-row"}
                onClick={() => setSelectedRunId(run.id)}
              >
                <span className="compact-row-main">{run.title}</span>
                <span className="compact-row-meta">{run.status.replace(/_/g, " ")}</span>
              </li>
            ))}
            {runs.length === 0 && <li className="empty-row muted">No meeting runs yet.</li>}
          </ul>
        </article>
      </div>

      <article className="pane-block">
        <div className="meeting-list-header">
          <h3 className="block-title">Selected run</h3>
          {selectedRun?.status === "failed" ? (
            <button type="button" className="meeting-link-button" onClick={() => void handleRetry()}>
              {busyAction === "retry" ? "Retrying..." : "Retry transcription"}
            </button>
          ) : null}
        </div>
        {selectedRun ? (
          <div className="meeting-run-detail-grid">
            <dl className="detail-list">
              <div>
                <dt>Title</dt>
                <dd>{selectedRun.title}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selectedRun.status.replace(/_/g, " ")}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{selectedRun.recordingSource?.replace(/_/g, " ") ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{new Date(selectedRun.startedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd>{selectedRun.progressLabel ?? (isActiveMeetingRun(selectedRun) ? "In progress" : "Ready")}</dd>
              </div>
              <div>
                <dt>Error</dt>
                <dd>{selectedRun.errorMessage ?? "None"}</dd>
              </div>
            </dl>

            <div className="meeting-artifacts-block">
              <h4>Artifacts</h4>
              <ul className="compact-list" role="list">
                {(selectedRun.artifacts ?? []).map((artifact) => (
                  <li key={artifact.id} className="compact-row static-row">
                    <span className="compact-row-main">{artifact.label ?? artifact.kind.replace(/_/g, " ")}</span>
                    <span className="compact-row-meta">{artifact.path}</span>
                  </li>
                ))}
                {(selectedRun.artifacts ?? []).length === 0 && (
                  <li className="empty-row muted">No artifacts saved yet.</li>
                )}
              </ul>
            </div>
          </div>
        ) : (
          <p className="muted">Select a meeting run to inspect transcripts and artifacts.</p>
        )}
      </article>
    </section>
  );
}

