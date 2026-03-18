import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ConfirmDialog } from "../components/shell/ConfirmDialog";
import { PaneHeader } from "../components/shell/PaneHeader";
import {
  openMeetingArtifactLocation,
  readMeetingArtifact
} from "../lib/meetingApi";
import type {
  Artifact,
  ArtifactKind,
  MeetingArtifactContent,
  RecordingSource,
  Run
} from "../models/run";
import type { Workspace } from "../models/workspace";

interface MeetingsScreenProps {
  workspace: Workspace;
  runs: Run[];
  loading: boolean;
  actionMessage: string | null;
  onImportFile: (meetingTitle: string, file: File) => Promise<void>;
  onStartRecording: (meetingTitle: string, source: RecordingSource) => Promise<void>;
  onStopRecording: (runId: string) => Promise<void>;
  onRetranscribeRun: (runId: string) => Promise<void>;
  onDeleteTranscripts: (runId: string) => Promise<void>;
  onDeleteRun: (runId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

type ReviewTabId = "cleaned" | "raw" | "provider" | "artifacts";
type ArtifactLoadState =
  | { status: "loading" }
  | { status: "loaded"; artifact: MeetingArtifactContent }
  | { status: "error"; message: string };

interface ContextMenuState {
  runId: string;
  x: number;
  y: number;
}

const recordingOptions: Array<{ value: RecordingSource; label: string; hint: string }> = [
  { value: "microphone", label: "Microphone", hint: "Default microphone input" },
  { value: "system_audio", label: "System audio", hint: "Loopback-capable device required" },
  { value: "mixed", label: "Mixed", hint: "Microphone plus system audio" }
];

const reviewTabs: Array<{ id: ReviewTabId; label: string }> = [
  { id: "cleaned", label: "Cleaned transcript" },
  { id: "raw", label: "Raw transcript" },
  { id: "provider", label: "Provider response" },
  { id: "artifacts", label: "Artifacts" }
];

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isActiveMeetingRun(run: Run) {
  return ["capturing", "queued_for_transcription", "transcribing", "cleaning"].includes(run.status);
}

function isRunDeletable(run: Run | undefined) {
  return Boolean(run && !isActiveMeetingRun(run));
}

function getArtifactKindForTab(tabId: ReviewTabId): ArtifactKind | null {
  switch (tabId) {
    case "cleaned":
      return "cleaned_transcript";
    case "raw":
      return "raw_transcript";
    case "provider":
      return "provider_response";
    default:
      return null;
  }
}

function findArtifact(run: Run | undefined, kind: ArtifactKind | null) {
  if (!run || !kind) {
    return undefined;
  }

  return run.artifacts?.find((artifact) => artifact.kind === kind);
}

function hasTranscriptArtifacts(run: Run | undefined) {
  return Boolean(
    run?.artifacts?.some((artifact) =>
      ["cleaned_transcript", "raw_transcript", "provider_response"].includes(artifact.kind)
    )
  );
}

function getDefaultReviewTab(run: Run | undefined): ReviewTabId {
  if (!run) {
    return "artifacts";
  }

  if (findArtifact(run, "cleaned_transcript")) {
    return "cleaned";
  }
  if (findArtifact(run, "raw_transcript")) {
    return "raw";
  }
  if (findArtifact(run, "provider_response")) {
    return "provider";
  }
  return "artifacts";
}

function isRetranscribable(run: Run | undefined) {
  if (!run || !run.inputPath || isActiveMeetingRun(run)) {
    return false;
  }

  return ["failed", "needs_review", "source_ready"].includes(run.status);
}

function formatStatusLabel(status: Run["status"]) {
  return status.replace(/_/g, " ");
}

function getEmptyStateCopy(run: Run, tabId: ReviewTabId) {
  if (tabId === "artifacts") {
    return {
      title: "No artifacts saved yet",
      description: "This run does not have any persisted artifacts to inspect yet."
    };
  }

  if (isActiveMeetingRun(run)) {
    return {
      title: "Transcript still processing",
      description: "This run is still capturing, transcribing, or cleaning. Refresh again once processing completes."
    };
  }

  if (run.status === "source_ready") {
    return {
      title: "Transcript deleted",
      description: "Transcript artifacts were deleted for this run. The source recording remains available for retranscription."
    };
  }

  if (run.status === "failed") {
    return {
      title: "Transcription failed",
      description: "This run does not currently have transcript output. Use Retranscribe to try again from the original source file."
    };
  }

  return {
    title: "No transcript available",
    description: "This transcript view does not have a saved artifact for the selected run yet."
  };
}

function ReviewEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="meeting-review-empty-state">
      <h4>{title}</h4>
      <p className="muted">{description}</p>
    </div>
  );
}

export function MeetingsScreen({
  workspace,
  runs,
  loading,
  actionMessage,
  onImportFile,
  onStartRecording,
  onStopRecording,
  onRetranscribeRun,
  onDeleteTranscripts,
  onDeleteRun,
  onRefresh
}: MeetingsScreenProps) {
  const [meetingTitle, setMeetingTitle] = useState("New meeting");
  const [recordingSource, setRecordingSource] = useState<RecordingSource>("microphone");
  const [selectedRunId, setSelectedRunId] = useState<string>(runs[0]?.id ?? "");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [selectedReviewTab, setSelectedReviewTab] = useState<ReviewTabId>("artifacts");
  const [artifactContentState, setArtifactContentState] = useState<Record<string, ArtifactLoadState>>({});
  const [panelMessage, setPanelMessage] = useState<string | null>(null);
  const [showDeleteTranscriptsDialog, setShowDeleteTranscriptsDialog] = useState(false);
  const [showDeleteRunDialog, setShowDeleteRunDialog] = useState(false);
  const [pendingDeleteRunId, setPendingDeleteRunId] = useState<string | null>(null);
  const [runContextMenu, setRunContextMenu] = useState<ContextMenuState | null>(null);

  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0],
    [runs, selectedRunId]
  );
  const pendingDeleteRun = useMemo(
    () => runs.find((run) => run.id === pendingDeleteRunId),
    [pendingDeleteRunId, runs]
  );
  const contextMenuRun = useMemo(
    () => runs.find((run) => run.id === runContextMenu?.runId),
    [runContextMenu?.runId, runs]
  );
  const activeRecording = runs.find((run) => run.status === "capturing");
  const selectedArtifactKind = getArtifactKindForTab(selectedReviewTab);
  const selectedArtifact = findArtifact(selectedRun, selectedArtifactKind);
  const selectedArtifactCacheKey = selectedRun && selectedArtifact
    ? `${selectedRun.id}:${selectedArtifact.id}`
    : null;
  const currentArtifactState = selectedArtifactCacheKey
    ? artifactContentState[selectedArtifactCacheKey]
    : undefined;

  useEffect(() => {
    if (!runs.length) {
      setSelectedRunId("");
      return;
    }

    if (!runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (pendingDeleteRunId && !runs.some((run) => run.id === pendingDeleteRunId)) {
      setPendingDeleteRunId(null);
      setShowDeleteRunDialog(false);
    }

    if (runContextMenu && !runs.some((run) => run.id === runContextMenu.runId)) {
      setRunContextMenu(null);
    }
  }, [pendingDeleteRunId, runContextMenu, runs]);

  useEffect(() => {
    setSelectedReviewTab(getDefaultReviewTab(selectedRun));
    setPanelMessage(null);
  }, [selectedRun?.id]);

  useEffect(() => {
    if (!runContextMenu) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && contextMenuRef.current?.contains(target)) {
        return;
      }

      setRunContextMenu(null);
    };

    const closeMenu = () => setRunContextMenu(null);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRunContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [runContextMenu]);

  useEffect(() => {
    if (!selectedRun || selectedReviewTab === "artifacts" || !selectedArtifact || !selectedArtifactCacheKey) {
      return;
    }

    if (!isTauriRuntime()) {
      setArtifactContentState((current) => ({
        ...current,
        [selectedArtifactCacheKey]: {
          status: "error",
          message: "Artifact preview is only available in the desktop app."
        }
      }));
      return;
    }

    const existingState = artifactContentState[selectedArtifactCacheKey];
    if (existingState?.status === "loading" || existingState?.status === "loaded") {
      return;
    }

    let cancelled = false;

    setArtifactContentState((current) => ({
      ...current,
      [selectedArtifactCacheKey]: { status: "loading" }
    }));

    void (async () => {
      try {
        const artifact = await readMeetingArtifact(
          selectedRun.workspaceRoot ?? workspace.rootPath,
          selectedRun.id,
          selectedArtifact.kind
        );

        if (cancelled) {
          return;
        }

        setArtifactContentState((current) => ({
          ...current,
          [selectedArtifactCacheKey]: { status: "loaded", artifact }
        }));
      } catch (error) {
        if (cancelled) {
          return;
        }

        setArtifactContentState((current) => ({
          ...current,
          [selectedArtifactCacheKey]: {
            status: "error",
            message: String(error)
          }
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    artifactContentState,
    selectedArtifact,
    selectedArtifactCacheKey,
    selectedReviewTab,
    selectedRun,
    workspace.rootPath
  ]);

  const handleImportChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setBusyAction("import");
    try {
      await onImportFile(meetingTitle.trim() || file.name, file);
      event.target.value = "";
      setPanelMessage(null);
    } finally {
      setBusyAction(null);
    }
  };

  const handleStartRecording = async () => {
    setBusyAction("record");
    try {
      await onStartRecording(meetingTitle.trim() || "New meeting", recordingSource);
      setPanelMessage(null);
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
      setPanelMessage(null);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetranscribe = async () => {
    if (!selectedRun) {
      return;
    }

    setBusyAction("retranscribe");
    try {
      await onRetranscribeRun(selectedRun.id);
      setArtifactContentState((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([cacheKey]) => !cacheKey.startsWith(`${selectedRun.id}:`))
        )
      );
      setSelectedReviewTab("artifacts");
      setPanelMessage(null);
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmDeleteTranscripts = async () => {
    if (!selectedRun) {
      return;
    }

    setBusyAction("delete_transcripts");
    try {
      await onDeleteTranscripts(selectedRun.id);
      setArtifactContentState((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([cacheKey]) => !cacheKey.startsWith(`${selectedRun.id}:`))
        )
      );
      setSelectedReviewTab("artifacts");
      setPanelMessage(null);
      setShowDeleteTranscriptsDialog(false);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRequestDeleteRun = (runId: string) => {
    setRunContextMenu(null);
    setPendingDeleteRunId(runId);
    setShowDeleteRunDialog(true);
  };

  const handleConfirmDeleteRun = async () => {
    if (!pendingDeleteRun) {
      return;
    }

    setBusyAction("delete_run");
    try {
      await onDeleteRun(pendingDeleteRun.id);
      setArtifactContentState((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([cacheKey]) => !cacheKey.startsWith(`${pendingDeleteRun.id}:`))
        )
      );
      setPanelMessage(null);
      setPendingDeleteRunId(null);
      setShowDeleteRunDialog(false);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyArtifactPath = async (artifact: Artifact) => {
    try {
      await navigator.clipboard.writeText(artifact.path);
      setPanelMessage(`Copied path for ${artifact.label ?? artifact.kind.replace(/_/g, " ")}.`);
    } catch (error) {
      setPanelMessage(`Failed to copy artifact path: ${String(error)}`);
    }
  };

  const handleOpenArtifactLocation = async (artifact: Artifact) => {
    if (!isTauriRuntime()) {
      setPanelMessage("Open location is only available in the desktop app.");
      return;
    }

    try {
      await openMeetingArtifactLocation(artifact.path);
      setPanelMessage(`Opened location for ${artifact.label ?? artifact.kind.replace(/_/g, " ")}.`);
    } catch (error) {
      setPanelMessage(`Failed to open artifact location: ${String(error)}`);
    }
  };

  const renderReviewBody = () => {
    if (!selectedRun) {
      return <p className="muted">Select a meeting run to inspect transcripts and artifacts.</p>;
    }

    if (selectedReviewTab === "artifacts") {
      const artifacts = selectedRun.artifacts ?? [];
      if (!artifacts.length) {
        return (
          <ReviewEmptyState
            title="No artifacts saved yet"
            description="This run does not have any persisted artifacts to inspect yet."
          />
        );
      }

      return (
        <div className="meeting-artifacts-list">
          {artifacts.map((artifact) => (
            <article key={artifact.id} className="meeting-artifact-row">
              <div className="meeting-artifact-copy">
                <strong>{artifact.label ?? artifact.kind.replace(/_/g, " ")}</strong>
                <p className="muted">{artifact.path}</p>
              </div>
              <div className="meeting-artifact-actions">
                <button
                  type="button"
                  className="codex-terminal-button secondary"
                  onClick={() => void handleOpenArtifactLocation(artifact)}
                >
                  Open location
                </button>
                <button
                  type="button"
                  className="codex-terminal-button secondary"
                  onClick={() => void handleCopyArtifactPath(artifact)}
                >
                  Copy path
                </button>
              </div>
            </article>
          ))}
        </div>
      );
    }

    if (!selectedArtifact) {
      const emptyState = getEmptyStateCopy(selectedRun, selectedReviewTab);
      return <ReviewEmptyState title={emptyState.title} description={emptyState.description} />;
    }

    if (!currentArtifactState || currentArtifactState.status === "loading") {
      return <p className="muted">Loading artifact preview...</p>;
    }

    if (currentArtifactState.status === "error") {
      return <p className="muted">{currentArtifactState.message}</p>;
    }

    const artifact = currentArtifactState.artifact;

    return (
      <div className="meeting-preview-surface">
        <div className="meeting-preview-toolbar">
          <span className="muted">{artifact.path}</span>
          <div className="meeting-preview-toolbar-actions">
            <button
              type="button"
              className="codex-terminal-button secondary"
              onClick={() => void handleOpenArtifactLocation(selectedArtifact)}
            >
              Open location
            </button>
            <button
              type="button"
              className="codex-terminal-button secondary"
              onClick={() => void handleCopyArtifactPath(selectedArtifact)}
            >
              Copy path
            </button>
          </div>
        </div>

        {artifact.contentType === "markdown" ? (
          <div className="meeting-markdown-preview">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown>
          </div>
        ) : (
          <pre className="meeting-artifact-previewer">{artifact.content}</pre>
        )}
      </div>
    );
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
              <p className="muted">Windows-first capture. System audio uses native Windows loopback; microphone capture still uses FFmpeg.</p>
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
            <span>{loading ? "Refreshing runs..." : panelMessage ?? actionMessage ?? "Ready"}</span>
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
                onClick={() => {
                  setSelectedRunId(run.id);
                  setRunContextMenu(null);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelectedRunId(run.id);
                  setRunContextMenu({
                    runId: run.id,
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
              >
                <span className="compact-row-main">{run.title}</span>
                <span className="compact-row-meta">{formatStatusLabel(run.status)}</span>
              </li>
            ))}
            {runs.length === 0 && <li className="empty-row muted">No meeting runs yet.</li>}
          </ul>

          {runContextMenu && contextMenuRun ? (
            <div
              ref={contextMenuRef}
              className="meeting-runs-context-menu"
              style={{
                left: `${Math.min(runContextMenu.x, window.innerWidth - 220)}px`,
                top: `${Math.min(runContextMenu.y, window.innerHeight - 140)}px`
              }}
              role="menu"
              aria-label={`Actions for ${contextMenuRun.title}`}
            >
              <button
                type="button"
                className="meeting-runs-context-menu-item danger"
                role="menuitem"
                onClick={() => handleRequestDeleteRun(contextMenuRun.id)}
                disabled={busyAction !== null || !isRunDeletable(contextMenuRun)}
              >
                Delete run
              </button>
            </div>
          ) : null}
        </article>
      </div>

      <article className="pane-block meeting-review-panel">
        <div className="meeting-review-header">
          <div>
            <h3 className="block-title">Selected run</h3>
            {selectedRun ? <p className="muted">Review transcript output, inspect artifacts, or regenerate transcripts from the saved source media.</p> : null}
          </div>
          {selectedRun ? (
            <div className="meeting-review-actions">
              {isRetranscribable(selectedRun) ? (
                <button
                  type="button"
                  className="codex-terminal-button"
                  onClick={() => void handleRetranscribe()}
                  disabled={busyAction !== null}
                >
                  {busyAction === "retranscribe" ? "Queueing..." : "Retranscribe"}
                </button>
              ) : null}
              {hasTranscriptArtifacts(selectedRun) ? (
                <button
                  type="button"
                  className="codex-terminal-button secondary"
                  onClick={() => setShowDeleteTranscriptsDialog(true)}
                  disabled={busyAction !== null || isActiveMeetingRun(selectedRun)}
                >
                  {busyAction === "delete_transcripts" ? "Deleting..." : "Delete transcripts"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {selectedRun ? (
          <>
            <div className="meeting-run-summary-grid">
              <div className="meeting-run-summary-card">
                <span className="meeting-run-summary-label">Title</span>
                <strong>{selectedRun.title}</strong>
              </div>
              <div className="meeting-run-summary-card">
                <span className="meeting-run-summary-label">Source</span>
                <strong>{selectedRun.recordingSource?.replace(/_/g, " ") ?? "Unknown"}</strong>
              </div>
              <div className="meeting-run-summary-card">
                <span className="meeting-run-summary-label">Status</span>
                <strong>{formatStatusLabel(selectedRun.status)}</strong>
              </div>
              <div className="meeting-run-summary-card">
                <span className="meeting-run-summary-label">Progress</span>
                <strong>{selectedRun.progressLabel ?? (isActiveMeetingRun(selectedRun) ? "In progress" : "Ready")}</strong>
              </div>
              <div className="meeting-run-summary-card">
                <span className="meeting-run-summary-label">Started</span>
                <strong>{new Date(selectedRun.startedAt).toLocaleString()}</strong>
              </div>
              <div className="meeting-run-summary-card">
                <span className="meeting-run-summary-label">Error</span>
                <strong>{selectedRun.errorMessage ?? "None"}</strong>
              </div>
            </div>

            <div className="meeting-review-tabs" role="tablist" aria-label="Selected run review tabs">
              {reviewTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedReviewTab === tab.id}
                  className={selectedReviewTab === tab.id ? "meeting-review-tab active" : "meeting-review-tab"}
                  onClick={() => setSelectedReviewTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="meeting-review-body">{renderReviewBody()}</div>
          </>
        ) : (
          <p className="muted">Select a meeting run to inspect transcripts and artifacts.</p>
        )}
      </article>

      {showDeleteTranscriptsDialog && selectedRun ? (
        <ConfirmDialog
          title="Delete transcripts"
          message={`Delete transcript artifacts for "${selectedRun.title}"?`}
          description="This permanently removes the raw transcript, cleaned transcript, and provider response for this run. The original recording and recording log will remain available for retranscription."
          confirmLabel="Delete transcripts"
          cancelLabel="Cancel"
          danger
          onConfirm={() => void handleConfirmDeleteTranscripts()}
          onCancel={() => setShowDeleteTranscriptsDialog(false)}
        />
      ) : null}

      {showDeleteRunDialog && pendingDeleteRun ? (
        <ConfirmDialog
          title="Delete meeting run"
          message={`Delete "${pendingDeleteRun.title}"?`}
          description="This permanently removes the run folder, including the source recording, transcripts, logs, and any saved review artifacts. This cannot be undone."
          confirmLabel="Delete run"
          cancelLabel="Cancel"
          danger
          onConfirm={() => void handleConfirmDeleteRun()}
          onCancel={() => {
            setShowDeleteRunDialog(false);
            setPendingDeleteRunId(null);
          }}
        />
      ) : null}
    </section>
  );
}
