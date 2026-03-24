import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AppShell } from "./components/AppShell";
import { BottomPanel, type BottomPanelView } from "./components/shell/BottomPanel";
import { ConfirmDialog } from "./components/shell/ConfirmDialog";
import { RenameDialog } from "./components/shell/RenameDialog";
import {
  CodexTerminalPanel,
  type CodexSessionState,
  type CodexTerminalEntry,
  type TerminalHostInfo
} from "./components/shell/CodexTerminalPanel";
import {
  CollapsibleSidebar,
  type SidebarGroupData
} from "./components/shell/CollapsibleSidebar";
import { DocumentsSidebar, type DocumentTreeItem } from "./components/shell/DocumentsSidebar";
import { InspectorPane, type InspectorSection } from "./components/shell/InspectorPane";
import { RibbonRail, type RibbonSection, type RibbonUtilityAction } from "./components/shell/RibbonRail";
import { WorkspacePane } from "./components/shell/WorkspacePane";
import { WindowTitleBar } from "./components/shell/WindowTitleBar";
import {
  CodeIcon,
  DocumentIcon,
  FolderIcon,
  GearIcon,
  HomeIcon,
  MeetingIcon,
  MoonIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  RunIcon,
  SunIcon,
  VaultIcon
} from "./components/shell/icons";
import { artifacts as mockArtifacts, runs as mockRuns, workspaces } from "./data/mockData";
import {
  getTranscriptionSettings,
  importMeetingFile,
  listMeetingRuns,
  deleteMeetingTranscripts,
  deleteMeetingRun,
  retranscribeMeetingRun,
  saveTranscriptionSettings,
  startRecording,
  stopRecording,
  type TranscriptionSettings
} from "./lib/meetingApi";
import { useLocalStorageState } from "./hooks/useLocalStorageState";
import {
  copyDocumentNoteFile,
  deleteDocumentNoteFile,
  writeDocumentNoteFile
} from "./services/documentsFileStore";
import type { RecordingSource, Run, RunStatus } from "./models/run";
import { CodexScreen } from "./screens/CodexScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { MeetingsScreen } from "./screens/MeetingsScreen";
import { DocumentsScreen } from "./screens/DocumentsScreen";
import { RunsScreen } from "./screens/RunsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { VaultScreen } from "./screens/VaultScreen";

type SectionId =
  | "home"
  | "meetings"
  | "vault"
  | "documents"
  | "runs"
  | "codex"
  | "settings";
type ThemeMode = "dark" | "light";
type DocumentsEditorFont = "ibm-plex-sans" | "switzer";

interface SpawnCodexProcessResponse {
  session_id: string;
  status: string;
  message: string;
  terminal_mode: "full_screen" | "compact";
  terminal_host: {
    windows_pty: {
      backend: "conpty" | "winpty";
      build_number?: number | null;
    } | null;
  };
  capture_bundle_path?: string | null;
}

interface OperationAck {
  ok: boolean;
  message: string;
}


interface TerminalExitEventPayload {
  session_id: string;
  code: number | null;
  capture_bundle_path?: string | null;
}

interface TerminalLifecycleEventPayload {
  session_id: string;
  phase: "session_started" | "first_pty_output" | "stop_requested" | "resize_applied" | "exit_observed";
  timestamp_ms: number;
  terminal_mode: "full_screen" | "compact";
  terminal_host: {
    windows_pty: {
      backend: "conpty" | "winpty";
      build_number?: number | null;
    } | null;
  };
  cols?: number | null;
  rows?: number | null;
  capture_bundle_path?: string | null;
}

const TERMINAL_EXIT_EVENT = "codex://terminal-exit";
const TERMINAL_LIFECYCLE_EVENT = "codex://terminal-lifecycle";

interface WorkspaceTabState {
  id: string;
  title: string;
  kind: "section" | "scratch" | "document";
  sectionId?: SectionId;
  documentItemId?: string;
  closable: boolean;
  pinned: boolean;
}

const sectionTitles: Record<SectionId, string> = {
  home: "Home",
  meetings: "Meetings",
  vault: "Vault",
  documents: "Documents",
  runs: "Runs",
  codex: "Codex",
  settings: "Settings"
};

const railSections: RibbonSection[] = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "meetings", label: "Meetings", icon: <MeetingIcon /> },
  { id: "vault", label: "Vault", icon: <VaultIcon /> },
  { id: "documents", label: "Documents", icon: <DocumentIcon /> },
  { id: "runs", label: "Runs", icon: <RunIcon /> },
  { id: "codex", label: "Codex", icon: <CodeIcon /> },
  { id: "settings", label: "Settings", icon: <GearIcon /> }
];

const initialDocumentsSidebarItems: DocumentTreeItem[] = [
  { id: "documents-folder-bita", label: "Bita", kind: "folder" },
  { id: "documents-folder-dyve-internal", label: "Dyve Internal", kind: "folder" },
  { id: "documents-folder-gt", label: "GT", kind: "folder" },
  { id: "documents-folder-personligt", label: "Personligt", kind: "folder" },
  {
    id: "documents-folder-pps",
    label: "PPS",
    kind: "folder",
    children: [{ id: "documents-folder-konsultmatchare", label: "Konsultmatchare", kind: "folder" }]
  }
];

function isDocumentFolder(item: DocumentTreeItem) {
  return item.kind !== "note";
}

function isDocumentNote(item: DocumentTreeItem) {
  return (item.kind ?? "folder") === "note";
}

function getDocumentMarkdownStorageKey(noteId: string) {
  return `documents.markdown.${noteId}`;
}

function collectClonedNoteIdPairs(
  source: DocumentTreeItem,
  clone: DocumentTreeItem,
  pairs: Array<[sourceId: string, clonedId: string]> = []
) {
  if (isDocumentNote(source)) {
    pairs.push([source.id, clone.id]);
  }

  const sourceChildren = source.children ?? [];
  const clonedChildren = clone.children ?? [];
  const branchLength = Math.min(sourceChildren.length, clonedChildren.length);

  for (let index = 0; index < branchLength; index += 1) {
    collectClonedNoteIdPairs(sourceChildren[index], clonedChildren[index], pairs);
  }

  return pairs;
}

function collectDocumentNoteIds(
  item: DocumentTreeItem,
  noteIds: string[] = []
): string[] {
  if (isDocumentNote(item)) {
    noteIds.push(item.id);
  }

  item.children?.forEach((child) => {
    collectDocumentNoteIds(child, noteIds);
  });

  return noteIds;
}

function findDocumentItem(items: DocumentTreeItem[], itemId: string): DocumentTreeItem | undefined {
  for (const item of items) {
    if (item.id === itemId) {
      return item;
    }

    if (item.children?.length) {
      const match = findDocumentItem(item.children, itemId);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

function countDocumentItemsByKind(items: DocumentTreeItem[], kind: "folder" | "note"): number {
  return items.reduce((count, item) => {
    const ownCount = (item.kind ?? "folder") === kind ? 1 : 0;
    const childrenCount = item.children?.length ? countDocumentItemsByKind(item.children, kind) : 0;
    return count + ownCount + childrenCount;
  }, 0);
}

function findDocumentParentFolderId(
  items: DocumentTreeItem[],
  itemId: string,
  parentFolderId: string | null = null
): string | null {
  for (const item of items) {
    if (item.id === itemId) {
      return parentFolderId;
    }

    if (item.children?.length) {
      const nextParentFolderId = isDocumentFolder(item) ? item.id : parentFolderId;
      const match = findDocumentParentFolderId(item.children, itemId, nextParentFolderId);
      if (match !== null) {
        return match;
      }
    }
  }

  return null;
}

function appendDocumentItem(
  items: DocumentTreeItem[],
  parentFolderId: string | null,
  nextItem: DocumentTreeItem
): DocumentTreeItem[] {
  if (!parentFolderId) {
    return [...items, nextItem];
  }

  const updatedItems = items.map((item) => {
    if (item.id === parentFolderId && isDocumentFolder(item)) {
      return {
        ...item,
        children: [...(item.children ?? []), nextItem]
      };
    }

    if (item.children?.length) {
      return {
        ...item,
        children: appendDocumentItem(item.children, parentFolderId, nextItem)
      };
    }

    return item;
  });

  return updatedItems;
}

function updateDocumentLabel(
  items: DocumentTreeItem[],
  itemId: string,
  nextLabel: string
): DocumentTreeItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return {
        ...item,
        label: nextLabel
      };
    }

    if (item.children?.length) {
      return {
        ...item,
        children: updateDocumentLabel(item.children, itemId, nextLabel)
      };
    }

    return item;
  });
}

function removeDocumentItem(
  items: DocumentTreeItem[],
  itemId: string
): { items: DocumentTreeItem[]; removedIds: string[] } {
  const removedIds: string[] = [];

  const nextItems = items.flatMap((item) => {
    if (item.id === itemId) {
      const collectRemoved = (entry: DocumentTreeItem) => {
        removedIds.push(entry.id);
        entry.children?.forEach(collectRemoved);
      };
      collectRemoved(item);
      return [];
    }

    if (item.children?.length) {
      const result = removeDocumentItem(item.children, itemId);
      if (result.removedIds.length) {
        removedIds.push(...result.removedIds);
        return [
          {
            ...item,
            children: result.items
          }
        ];
      }
    }

    return [item];
  });

  return {
    items: nextItems,
    removedIds
  };
}

function documentTreeContainsId(item: DocumentTreeItem, targetId: string): boolean {
  if (item.id === targetId) {
    return true;
  }

  if (!item.children?.length) {
    return false;
  }

  return item.children.some((child) => documentTreeContainsId(child, targetId));
}

function detachDocumentItem(
  items: DocumentTreeItem[],
  itemId: string
): { items: DocumentTreeItem[]; item: DocumentTreeItem | null } {
  let detachedItem: DocumentTreeItem | null = null;

  const nextItems = items.flatMap((item) => {
    if (item.id === itemId) {
      detachedItem = item;
      return [];
    }

    if (item.children?.length) {
      const nestedDetach = detachDocumentItem(item.children, itemId);
      if (nestedDetach.item) {
        detachedItem = nestedDetach.item;
        return [
          {
            ...item,
            children: nestedDetach.items
          }
        ];
      }
    }

    return [item];
  });

  return {
    items: nextItems,
    item: detachedItem
  };
}
function findDocumentLabelPath(
  items: DocumentTreeItem[],
  itemId: string,
  segments: string[] = []
): string[] | null {
  for (const item of items) {
    const nextSegments = [...segments, item.label];

    if (item.id === itemId) {
      return nextSegments;
    }

    if (item.children?.length) {
      const found = findDocumentLabelPath(item.children, itemId, nextSegments);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function createDocumentItemId(kind: "folder" | "note") {
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `documents-${kind}-${Date.now()}-${randomSuffix}`;
}

function cloneDocumentItem(item: DocumentTreeItem): DocumentTreeItem {
  const itemKind = item.kind ?? "folder";

  return {
    id: createDocumentItemId(itemKind),
    label: item.label,
    kind: itemKind,
    children: item.children?.map(cloneDocumentItem)
  };
}

const statusLabels: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  capturing: "Capturing",
  source_ready: "Ready to retranscribe",
  imported: "Imported",
  queued_for_transcription: "Queued for transcription",
  transcribing: "Transcribing",
  cleaning: "Cleaning",
  needs_review: "Needs review",
  completed: "Completed",
  failed: "Failed"
};

const statusTone: Record<RunStatus, "neutral" | "warning" | "success" | "danger"> = {
  queued: "neutral",
  running: "neutral",
  capturing: "neutral",
  source_ready: "warning",
  imported: "neutral",
  queued_for_transcription: "neutral",
  transcribing: "neutral",
  cleaning: "neutral",
  needs_review: "warning",
  completed: "success",
  failed: "danger"
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const BOTTOM_PANEL_MIN_HEIGHT = 140;
const APP_STATUS_BAR_HEIGHT = 28;
const MIN_WORKSPACE_VIEW_HEIGHT = 140;

function getBottomPanelMaxHeight(viewportHeight: number) {
  const maxVisibleHeight = Math.max(0, viewportHeight - APP_STATUS_BAR_HEIGHT);
  const preferredHeight = Math.max(
    BOTTOM_PANEL_MIN_HEIGHT,
    viewportHeight - (APP_STATUS_BAR_HEIGHT + MIN_WORKSPACE_VIEW_HEIGHT)
  );

  return Math.min(maxVisibleHeight, preferredHeight);
}

function clampBottomPanelHeight(height: number, viewportHeight: number) {
  const maxHeight = getBottomPanelMaxHeight(viewportHeight);
  const minHeight = Math.min(BOTTOM_PANEL_MIN_HEIGHT, maxHeight);
  return Math.round(clamp(height, minHeight, maxHeight));
}

function createSectionTab(sectionId: SectionId): WorkspaceTabState {
  return {
    id: `tab-${sectionId}`,
    title: sectionTitles[sectionId],
    kind: "section",
    sectionId,
    closable: true,
    pinned: false
  };
}

function makeRunRow(
  runId: string,
  label: string,
  meta: string,
  tone: "neutral" | "warning" | "success" | "danger" = "neutral"
) {
  return {
    id: runId,
    label,
    meta,
    tone
  };
}

function sortRunsByStartedAt(items: Run[]) {
  return [...items].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function mapTerminalHostInfo(hostInfo: {
  windows_pty: {
    backend: "conpty" | "winpty";
    build_number?: number | null;
  } | null;
}): TerminalHostInfo {
  return {
    windowsPty: hostInfo.windows_pty
      ? {
          backend: hostInfo.windows_pty.backend,
          buildNumber: hostInfo.windows_pty.build_number ?? undefined
        }
      : null
  };
}

function isActiveRunStatus(status: RunStatus) {
  return [
    "queued",
    "running",
    "capturing",
    "queued_for_transcription",
    "transcribing",
    "cleaning"
  ].includes(status);
}

function App() {
  const workspace = workspaces[0];

  const [theme, setTheme] = useLocalStorageState<ThemeMode>("shell.theme", "dark");
  const [activeSection, setActiveSection] = useLocalStorageState<SectionId>(
    "shell.activeSection",
    "home"
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState<boolean>(
    "shell.sidebarCollapsed",
    false
  );
  const [inspectorOpen, setInspectorOpen] = useLocalStorageState<boolean>("shell.inspectorOpen", false);
  const [bottomPanelOpen, setBottomPanelOpen] = useLocalStorageState<boolean>(
    "shell.bottomPanelOpen",
    false
  );
  const [sidebarWidth, setSidebarWidth] = useLocalStorageState<number>("shell.sidebarWidth", 268);
  const [inspectorWidth, setInspectorWidth] = useLocalStorageState<number>(
    "shell.inspectorWidth",
    296
  );
  const [bottomPanelHeight, setBottomPanelHeight] = useLocalStorageState<number>(
    "shell.bottomHeight",
    188
  );
  const effectiveBottomPanelHeight = useMemo(() => {
    if (typeof window === "undefined") {
      return bottomPanelHeight;
    }

    return clampBottomPanelHeight(bottomPanelHeight, window.innerHeight);
  }, [bottomPanelHeight]);

  const [tabs, setTabs] = useState<WorkspaceTabState[]>([createSectionTab("home")]);
  const [activeTabId, setActiveTabId] = useState<string>("tab-home");
  const [activeBottomViewId, setActiveBottomViewId] = useState<string>("status");
  const [selectedSidebarItems, setSelectedSidebarItems] = useLocalStorageState<Record<SectionId, string>>(
    "shell.sidebarSelections",
    {
      home: "home-recent-run",
      meetings: "meetings-new-recording",
      vault: "vault-info",
      documents: "documents-folder-bita",
      runs: "runs-running",
      codex: "codex-workspace",
      settings: "settings-general"
    }
  );

  const [documentsSidebarItems, setDocumentsSidebarItems] = useLocalStorageState<DocumentTreeItem[]>(
    "documents.sidebarItems",
    initialDocumentsSidebarItems
  );
  const [pendingDelete, setPendingDelete] = useState<{
    itemId: string;
    label: string;
    kind: "folder" | "note";
  } | null>(null);
  const [pendingRename, setPendingRename] = useState<{
    itemId: string;
    label: string;
    kind: "folder" | "note";
    value: string;
  } | null>(null);

  const [codexSession, setCodexSession] = useState<CodexSessionState>({
    sessionId: null,
    status: "idle",
    message: "Ready",
    lastExitCode: null,
    terminalMode: null,
    captureBundlePath: null,
    lastLifecyclePhase: null,
    lastResize: null
  });
  const [codexTerminalHostInfo, setCodexTerminalHostInfo] = useState<TerminalHostInfo | null>(null);
  const [codexTerminalEntries, setCodexTerminalEntries] = useState<CodexTerminalEntry[]>([]);
  const [codexTerminalClearSignal, setCodexTerminalClearSignal] = useState(0);
  const [codexCommandPath, setCodexCommandPath] = useLocalStorageState<string>(
    "settings.codex.commandPath",
    "codex"
  );
  const [codexDisableAltScreen, setCodexDisableAltScreen] = useLocalStorageState<boolean>(
    "settings.codex.disableAltScreen",
    false
  );
  const [codexCaptureDebugBundle, setCodexCaptureDebugBundle] = useLocalStorageState<boolean>(
    "settings.codex.captureDebugBundle",
    false
  );
  const [documentsOpenInNewTab, setDocumentsOpenInNewTab] = useLocalStorageState<boolean>(
    "settings.documents.openInNewTab",
    true
  );
  const [documentsBasePath, setDocumentsBasePath] = useLocalStorageState<string>(
    "settings.documents.basePath",
    ""
  );
  const [documentsEditorFont, setDocumentsEditorFont] = useLocalStorageState<DocumentsEditorFont>(
    "settings.documents.editorFont",
    "switzer"
  );
  const staticRuns = useMemo(
    () => mockRuns.filter((run) => run.type !== "meeting_import" && run.type !== "meeting_recording"),
    []
  );
  const fallbackMeetingRuns = useMemo(
    () => sortRunsByStartedAt(mockRuns.filter((run) => run.type === "meeting_import" || run.type === "meeting_recording")),
    []
  );
  const [meetingRuns, setMeetingRuns] = useState<Run[]>(fallbackMeetingRuns);
  const [meetingRunsLoading, setMeetingRunsLoading] = useState(false);
  const [meetingActionMessage, setMeetingActionMessage] = useState<string | null>(null);
  const [openAiApiKey, setOpenAiApiKey] = useLocalStorageState<string>(
    "settings.transcription.openAiApiKey",
    ""
  );
  const [cleanupModel, setCleanupModel] = useLocalStorageState<string>(
    "settings.transcription.cleanupModel",
    "gpt-5-mini"
  );
  const [ffmpegPath, setFfmpegPath] = useLocalStorageState<string>(
    "settings.transcription.ffmpegPath",
    "ffmpeg"
  );
  const [diarizationEnabled, setDiarizationEnabled] = useLocalStorageState<boolean>(
    "settings.transcription.diarizationEnabled",
    false
  );
  const [transcriptionStatusMessage, setTranscriptionStatusMessage] = useState<string | null>(null);
  const transcriptionSettings = useMemo<TranscriptionSettings>(
    () => ({
      openAiApiKey: openAiApiKey || undefined,
      cleanupModel,
      ffmpegPath,
      transcriptionModel: "gpt-4o-transcribe",
      diarizationEnabled
    }),
    [cleanupModel, diarizationEnabled, ffmpegPath, openAiApiKey]
  );
  const sortedRuns = useMemo(() => sortRunsByStartedAt([...staticRuns, ...meetingRuns]), [meetingRuns, staticRuns]);
  const artifactCount = useMemo(
    () => mockArtifacts.length + meetingRuns.reduce((count, run) => count + (run.artifacts?.length ?? 0), 0),
    [meetingRuns]
  );

  const runStats = useMemo(
    () => ({
      total: sortedRuns.length,
      openReviewCount: sortedRuns.filter((run) => run.status === "needs_review").length,
      runningCount: sortedRuns.filter((run) => isActiveRunStatus(run.status)).length
    }),
    [sortedRuns]
  );

  const appendTerminalEntry = useCallback((entry: CodexTerminalEntry) => {
    setCodexTerminalEntries((current) => [...current.slice(-499), entry]);
  }, []);

  const sidebarGroupsBySection = useMemo<Record<SectionId, SidebarGroupData[]>>(() => {
    const recentMeetingRuns = sortedRuns.filter(
      (run) => run.type === "meeting_import" || run.type === "meeting_recording"
    );
    const runningRuns = sortedRuns.filter((run) => isActiveRunStatus(run.status));
    const awaitingReview = sortedRuns.filter((run) => run.status === "needs_review");
    const completedRuns = sortedRuns.filter((run) => run.status === "completed");
    const failedRuns = sortedRuns.filter((run) => run.status === "failed");
    const codexRuns = sortedRuns.filter((run) => run.type === "codex_session");

    return {
      home: [
        {
          id: "home-recent",
          title: "Recent items",
          items: sortedRuns.slice(0, 5).map((run) =>
            makeRunRow(
              `home-recent-${run.id}`,
              run.title,
              `${statusLabels[run.status]} - ${new Date(run.startedAt).toLocaleDateString()}`,
              statusTone[run.status]
            )
          )
        },
        {
          id: "home-continue",
          title: "Continue working",
          items: [...runningRuns, ...awaitingReview].slice(0, 4).map((run) =>
            makeRunRow(
              `home-continue-${run.id}`,
              run.title,
              `${statusLabels[run.status]} - ${run.type.replace("_", " ")}`,
              statusTone[run.status]
            )
          )
        },
        {
          id: "home-review",
          title: "Awaiting review",
          items: awaitingReview.map((run) =>
            makeRunRow(
              `home-review-${run.id}`,
              run.title,
              `Started ${new Date(run.startedAt).toLocaleString()}`,
              "warning"
            )
          )
        }
      ],
      meetings: [
        {
          id: "meetings-actions",
          title: "Meeting actions",
          items: [
            { id: "meetings-new-recording", label: "New recording", meta: "Mic or mixed input" },
            { id: "meetings-import", label: "Import meeting", meta: "Audio or video file" }
          ]
        },
        {
          id: "meetings-recent-runs",
          title: "Recent meeting runs",
          items: recentMeetingRuns.slice(0, 6).map((run) =>
            makeRunRow(
              `meetings-run-${run.id}`,
              run.title,
              `${statusLabels[run.status]} - ${new Date(run.startedAt).toLocaleDateString()}`,
              statusTone[run.status]
            )
          )
        },
        {
          id: "meetings-drafts",
          title: "Drafts",
          items: [
            { id: "meetings-draft-notes", label: "Q2 planning notes", meta: "Clean transcript draft" },
            { id: "meetings-draft-retro", label: "Sprint retrospective", meta: "Pending owner mapping" }
          ]
        }
      ],
      runs: [
        {
          id: "runs-running-group",
          title: "Running",
          items: runningRuns.map((run) =>
            makeRunRow(`runs-running-${run.id}`, run.title, run.type.replace("_", " "), "neutral")
          )
        },
        {
          id: "runs-review-group",
          title: "Awaiting review",
          items: awaitingReview.map((run) =>
            makeRunRow(`runs-review-${run.id}`, run.title, run.summary ?? "Review required", "warning")
          )
        },
        {
          id: "runs-completed-group",
          title: "Completed",
          items: completedRuns.map((run) =>
            makeRunRow(`runs-completed-${run.id}`, run.title, run.summary ?? "Completed", "success")
          )
        },
        {
          id: "runs-failed-group",
          title: "Failed",
          items: failedRuns.map((run) =>
            makeRunRow(`runs-failed-${run.id}`, run.title, run.summary ?? "Requires retry", "danger")
          )
        }
      ],
      vault: [
        {
          id: "vault-config",
          title: "Vault info",
          items: [
            { id: "vault-info", label: workspace.obsidian.vaultPath, meta: "Configured vault root" },
            {
              id: "vault-publish-folder",
              label: workspace.obsidian.publishFolder,
              meta: "Default publish path"
            }
          ]
        },
        {
          id: "vault-output",
          title: "Output folders",
          items: [
            { id: "vault-output-transcripts", label: "Transcripts", meta: "Meetings/Transcripts" },
            { id: "vault-output-notes", label: "Notes", meta: "Meetings/Notes" },
            { id: "vault-output-publish", label: "Publish Queue", meta: "Meetings/Inbox" }
          ]
        },
        {
          id: "vault-templates",
          title: "Templates",
          items: [
            { id: "vault-template-weekly", label: "Weekly Sync", meta: "Decision/action template" },
            { id: "vault-template-review", label: "Review Checklist", meta: "Quality gate" }
          ]
        },
        {
          id: "vault-publish-queue",
          title: "Publish queue",
          items: awaitingReview.slice(0, 4).map((run) =>
            makeRunRow(
              `vault-queue-${run.id}`,
              run.title,
              `Ready for review - ${new Date(run.startedAt).toLocaleDateString()}`,
              "warning"
            )
          )
        }
      ],
      documents: [
        {
          id: "documents-workspace",
          title: "Workspace",
          items: [
            { id: "documents-editor", label: "Markdown editor", meta: "Live write + preview" },
            { id: "documents-scratch", label: "Scratch note", meta: "Quick capture buffer" }
          ]
        },
        {
          id: "documents-recent",
          title: "Recent",
          items: [
            {
              id: "documents-recent-kickoff",
              label: "Q2 kickoff brief",
              meta: "Last edited today"
            },
            {
              id: "documents-recent-publish-checklist",
              label: "Publish checklist",
              meta: "Table and task list"
            }
          ]
        },
        {
          id: "documents-templates",
          title: "Templates",
          items: [
            { id: "documents-template-meeting", label: "Meeting note template", meta: "Summary + actions" },
            { id: "documents-template-decision", label: "Decision log template", meta: "Owners + due dates" }
          ]
        }
      ],
      codex: [
        {
          id: "codex-workspace-group",
          title: "Active workspace",
          items: [
            { id: "codex-workspace", label: workspace.name, meta: workspace.rootPath },
            { id: "codex-profile", label: "Default profile", meta: "Local Codex CLI session" }
          ]
        },
        {
          id: "codex-recent-sessions",
          title: "Recent sessions",
          items: codexRuns.map((run) =>
            makeRunRow(
              `codex-session-${run.id}`,
              run.title,
              `${statusLabels[run.status]} - ${new Date(run.startedAt).toLocaleDateString()}`,
              statusTone[run.status]
            )
          )
        },
        {
          id: "codex-prompts",
          title: "Saved prompts",
          items: [
            { id: "codex-prompt-review", label: "Run review prompt", meta: "Summarize and highlight risk" },
            { id: "codex-prompt-plan", label: "Plan synthesis prompt", meta: "Extract next actions" }
          ]
        }
      ],
      settings: [
        {
          id: "settings-categories",
          title: "Categories",
          items: [
            { id: "settings-general", label: "General", meta: "App and display" },
            { id: "settings-workspace", label: "Workspace", meta: "Root paths and defaults" },
            { id: "settings-vault", label: "Vault", meta: "Publish safety and routing" },
            { id: "settings-transcription", label: "Transcription", meta: "Provider setup" },
            { id: "settings-codex", label: "Codex", meta: "CLI integration defaults" }
          ]
        }
      ]
    };
  }, [sortedRuns, workspace]);

  const refreshMeetingRuns = useCallback(async () => {
    if (!isTauriRuntime()) {
      setMeetingRuns(fallbackMeetingRuns);
      return;
    }

    setMeetingRunsLoading(true);
    try {
      const liveRuns = await listMeetingRuns({
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath
      });
      setMeetingRuns(sortRunsByStartedAt(liveRuns));
    } catch (error) {
      setMeetingActionMessage(`Failed to load meeting runs: ${String(error)}`);
    } finally {
      setMeetingRunsLoading(false);
    }
  }, [fallbackMeetingRuns, workspace.id, workspace.rootPath]);

  const handleImportMeetingFile = useCallback(
    async (meetingTitle: string, file: File) => {
      try {
        const run = await importMeetingFile(
          {
            workspaceId: workspace.id,
            workspaceRoot: workspace.rootPath
          },
          meetingTitle,
          file
        );
        setMeetingActionMessage(`Imported '${run.title}' and queued transcription.`);
        await refreshMeetingRuns();
      } catch (error) {
        setMeetingActionMessage(`Import failed: ${String(error)}`);
      }
    },
    [refreshMeetingRuns, workspace.id, workspace.rootPath]
  );

  const handleStartMeetingRecording = useCallback(
    async (meetingTitle: string, source: RecordingSource) => {
      try {
        const response = await startRecording(
          {
            workspaceId: workspace.id,
            workspaceRoot: workspace.rootPath
          },
          meetingTitle,
          source
        );
        setMeetingActionMessage(response.message);
        await refreshMeetingRuns();
      } catch (error) {
        setMeetingActionMessage(`Recording start failed: ${String(error)}`);
      }
    },
    [refreshMeetingRuns, workspace.id, workspace.rootPath]
  );

  const handleStopMeetingRecording = useCallback(
    async (runId: string) => {
      try {
        await stopRecording(runId);
        setMeetingActionMessage('Recording stopped. Transcription queued.');
        await refreshMeetingRuns();
      } catch (error) {
        setMeetingActionMessage(`Recording stop failed: ${String(error)}`);
      }
    },
    [refreshMeetingRuns]
  );

  const handleRetranscribeMeetingRun = useCallback(
    async (runId: string) => {
      try {
        const run = await retranscribeMeetingRun(workspace.rootPath, runId);
        setMeetingActionMessage(`Queued transcription for '${run.title}'.`);
        await refreshMeetingRuns();
      } catch (error) {
        setMeetingActionMessage(`Retranscribe failed: ${String(error)}`);
      }
    },
    [refreshMeetingRuns, workspace.rootPath]
  );

  const handleDeleteMeetingTranscripts = useCallback(
    async (runId: string) => {
      try {
        await deleteMeetingTranscripts(workspace.rootPath, runId);
        setMeetingActionMessage("Deleted transcript artifacts. Recording retained.");
        await refreshMeetingRuns();
      } catch (error) {
        setMeetingActionMessage(`Delete transcripts failed: ${String(error)}`);
      }
    },
    [refreshMeetingRuns, workspace.rootPath]
  );

  const handleDeleteMeetingRun = useCallback(
    async (runId: string) => {
      try {
        await deleteMeetingRun(workspace.rootPath, runId);
        setMeetingActionMessage("Deleted meeting run.");
        await refreshMeetingRuns();
      } catch (error) {
        setMeetingActionMessage(`Delete run failed: ${String(error)}`);
      }
    },
    [refreshMeetingRuns, workspace.rootPath]
  );

  const handleSaveTranscriptionSettings = useCallback(
    async (settingsInput: TranscriptionSettings) => {
      try {
        const saved = await saveTranscriptionSettings(settingsInput);
        setOpenAiApiKey(saved.openAiApiKey ?? '');
        setCleanupModel(saved.cleanupModel);
        setFfmpegPath(saved.ffmpegPath);
        setDiarizationEnabled(saved.diarizationEnabled);
        setTranscriptionStatusMessage('Transcription settings saved.');
      } catch (error) {
        setTranscriptionStatusMessage(`Failed to save transcription settings: ${String(error)}`);
      }
    },
    [setCleanupModel, setDiarizationEnabled, setFfmpegPath, setOpenAiApiKey]
  );

  useEffect(() => {
    void refreshMeetingRuns();
  }, [refreshMeetingRuns]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshMeetingRuns();
    }, 4000);

    return () => window.clearInterval(intervalId);
  }, [refreshMeetingRuns]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void (async () => {
      try {
        const settingsValue = await getTranscriptionSettings();
        setOpenAiApiKey(settingsValue.openAiApiKey ?? '');
        setCleanupModel(settingsValue.cleanupModel);
        setFfmpegPath(settingsValue.ffmpegPath);
        setDiarizationEnabled(settingsValue.diarizationEnabled);
      } catch (error) {
        setTranscriptionStatusMessage(`Failed to load transcription settings: ${String(error)}`);
      }
    })();
  }, [setCleanupModel, setDiarizationEnabled, setFfmpegPath, setOpenAiApiKey]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        setSidebarCollapsed((current) => !current);
      }

      if (key === "i") {
        event.preventDefault();
        setInspectorOpen((current) => !current);
      }

      if (key === "j") {
        event.preventDefault();
        setBottomPanelOpen((current) => !current);
      }

      if (key === "t") {
        event.preventDefault();
        const nextTab: WorkspaceTabState = {
          id: `scratch-${Date.now()}`,
          title: "Scratch",
          kind: "scratch",
          closable: true,
          pinned: false
        };
        setTabs((currentTabs) => [...currentTabs, nextTab]);
        setActiveTabId(nextTab.id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setBottomPanelOpen, setInspectorOpen, setSidebarCollapsed]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void invoke<SpawnCodexProcessResponse["terminal_host"]>("get_terminal_host_info")
      .then((hostInfo) => {
        setCodexTerminalHostInfo(mapTerminalHostInfo(hostInfo));
      })
      .catch(() => {
        setCodexTerminalHostInfo(null);
      });
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const unlistenFns: UnlistenFn[] = [];
    let disposed = false;

    const attachListeners = async () => {
      try {
        const unlistenLifecycle = await listen<TerminalLifecycleEventPayload>(TERMINAL_LIFECYCLE_EVENT, (event) => {
          setCodexTerminalHostInfo(mapTerminalHostInfo(event.payload.terminal_host));

          setCodexSession((current) => {
            if (current.sessionId !== event.payload.session_id) {
              return current;
            }

            return {
              ...current,
              terminalMode: event.payload.terminal_mode,
              captureBundlePath: event.payload.capture_bundle_path ?? current.captureBundlePath,
              lastLifecyclePhase: event.payload.phase,
              lastResize:
                event.payload.phase === "resize_applied" &&
                typeof event.payload.cols === "number" &&
                typeof event.payload.rows === "number"
                  ? { cols: event.payload.cols, rows: event.payload.rows }
                  : current.lastResize
            };
          });
        });

        const unlistenExit = await listen<TerminalExitEventPayload>(TERMINAL_EXIT_EVENT, (event) => {
          setCodexSession((current) => {
            if (current.sessionId !== event.payload.session_id) {
              return current;
            }

            return {
              ...current,
              status: "stopped",
              message: event.payload.capture_bundle_path
                ? `Process exited${event.payload.code === null ? "" : ` with code ${event.payload.code}`}. Capture bundle: ${event.payload.capture_bundle_path}`
                : `Process exited${event.payload.code === null ? "" : ` with code ${event.payload.code}`}.`,
              lastExitCode: event.payload.code,
              captureBundlePath: event.payload.capture_bundle_path ?? current.captureBundlePath,
              lastLifecyclePhase: "exit_observed"
            };
          });

          appendTerminalEntry({
            sessionId: event.payload.session_id,
            text:
              event.payload.code === null
                ? `\n[system] Codex process exited.${event.payload.capture_bundle_path ? `\n[system] Capture bundle: ${event.payload.capture_bundle_path}` : ""}\n`
                : `\n[system] Codex process exited with code ${event.payload.code}.${event.payload.capture_bundle_path ? `\n[system] Capture bundle: ${event.payload.capture_bundle_path}` : ""}\n`
          });
        });

        if (disposed) {
          unlistenLifecycle();
          unlistenExit();
          return;
        }

        unlistenFns.push(unlistenLifecycle);
        unlistenFns.push(unlistenExit);
      } catch (error) {
        appendTerminalEntry({
          sessionId: "unknown",
          text: `\n[system] Failed to register terminal listeners: ${String(error)}\n`
        });
      }
    };

    void attachListeners();

    return () => {
      disposed = true;
      unlistenFns.forEach((unlisten) => {
        unlisten();
      });
    };
  }, [appendTerminalEntry]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncBottomPanelHeight = () => {
      const nextHeight = clampBottomPanelHeight(bottomPanelHeight, window.innerHeight);
      if (nextHeight !== bottomPanelHeight) {
        setBottomPanelHeight(nextHeight);
      }
    };

    syncBottomPanelHeight();
    window.addEventListener("resize", syncBottomPanelHeight);
    return () => window.removeEventListener("resize", syncBottomPanelHeight);
  }, [bottomPanelHeight, setBottomPanelHeight]);

  const activeSidebarGroups = sidebarGroupsBySection[activeSection];
  const selectedSidebarItemId = (() => {
    const storedSelection = selectedSidebarItems[activeSection];
    if (activeSection === "documents") {
      if (storedSelection === "") {
        return "";
      }

      if (storedSelection && findDocumentItem(documentsSidebarItems, storedSelection)) {
        return storedSelection;
      }

      return "";
    }

    return storedSelection ?? activeSidebarGroups[0]?.items[0]?.id ?? "";
  })();

  const selectedDocumentItem = selectedSidebarItemId
    ? findDocumentItem(documentsSidebarItems, selectedSidebarItemId)
    : undefined;
  const selectedDocumentFolderLabel = selectedDocumentItem?.label;

  const createDocumentItem = (kind: "note" | "folder", parentFolderId?: string): DocumentTreeItem => {
    const nextId = createDocumentItemId(kind);
    const nextNumber = countDocumentItemsByKind(documentsSidebarItems, kind) + 1;
    const nextItem: DocumentTreeItem =
      kind === "folder"
        ? { id: nextId, label: `New folder ${nextNumber}`, kind: "folder", children: [] }
        : { id: nextId, label: `New note ${nextNumber}`, kind: "note" };

    setDocumentsSidebarItems((currentItems) => {
      const resolvedParentFolderId =
        typeof parentFolderId === "string"
          ? parentFolderId
          : (() => {
              const selectedItem = selectedSidebarItemId
                ? findDocumentItem(currentItems, selectedSidebarItemId)
                : undefined;

              if (!selectedItem) {
                return null;
              }

              if (isDocumentFolder(selectedItem)) {
                return selectedItem.id;
              }

              return findDocumentParentFolderId(currentItems, selectedItem.id);
            })();

      return appendDocumentItem(currentItems, resolvedParentFolderId, nextItem);
    });

    if (kind === "note" && typeof window !== "undefined") {
      window.localStorage.setItem(getDocumentMarkdownStorageKey(nextId), JSON.stringify(""));
    }
    if (kind === "note") {
      void writeDocumentNoteFile(nextId, "", documentsBasePath);
    }

    setSelectedSidebarItems((current) => ({
      ...current,
      documents: nextId
    }));
    setActiveSection("documents");

    return nextItem;
  };

  const handleCreateDocumentNote = (parentFolderId?: string) => createDocumentItem("note", parentFolderId);
  const handleCreateDocumentFolder = (parentFolderId?: string) =>
    createDocumentItem("folder", parentFolderId);

  const openDocumentNoteInTab = (item: DocumentTreeItem) => {
    const existingTab = tabs.find(
      (tab) => tab.kind === "document" && tab.documentItemId === item.id
    );

    if (existingTab) {
      setActiveTabId(existingTab.id);
      setActiveSection("documents");
      setSelectedSidebarItems((current) => ({
        ...current,
        documents: item.id
      }));
      return;
    }

    const nextTab: WorkspaceTabState = {
      id: `tab-document-${item.id}-${Date.now()}`,
      title: item.label,
      kind: "document",
      documentItemId: item.id,
      closable: true,
      pinned: false
    };

    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
    setActiveSection("documents");
    setSelectedSidebarItems((current) => ({
      ...current,
      documents: item.id
    }));
  };

  const handleOpenDocumentInNewTab = (itemId: string) => {
    const item = findDocumentItem(documentsSidebarItems, itemId);
    if (!item || isDocumentFolder(item)) {
      return;
    }

    openDocumentNoteInTab(item);
  };

  const handleOpenDocumentFromSidebar = (itemId: string) => {
    const item = findDocumentItem(documentsSidebarItems, itemId);
    if (!item || isDocumentFolder(item)) {
      return;
    }

    setSelectedSidebarItems((current) => ({
      ...current,
      documents: item.id
    }));

    if (documentsOpenInNewTab || activeTab.pinned) {
      openDocumentNoteInTab(item);
      return;
    }

    setActiveSection("documents");

    setTabs((currentTabs) =>
      currentTabs.map((tab) => {
        if (tab.id !== activeTab.id) {
          return tab;
        }

        if (tab.kind === "scratch") {
          return {
            ...tab,
            title: item.label,
            kind: "document",
            documentItemId: item.id
          };
        }

        if (tab.kind === "document") {
          return {
            ...tab,
            title: item.label,
            documentItemId: item.id
          };
        }

        if (tab.kind === "section") {
          return {
            ...tab,
            title: item.label,
            sectionId: "documents",
            documentItemId: item.id
          };
        }

        return {
          ...tab,
          title: item.label
        };
      })
    );
  };

  const handleMoveDocumentItem = (itemId: string, targetFolderId: string | null) => {
    if (targetFolderId !== null && itemId === targetFolderId) {
      return;
    }

    setDocumentsSidebarItems((currentItems) => {
      const sourceItem = findDocumentItem(currentItems, itemId);
      const targetFolder = targetFolderId ? findDocumentItem(currentItems, targetFolderId) : null;

      if (!sourceItem) {
        return currentItems;
      }

      if (targetFolderId !== null && (!targetFolder || !isDocumentFolder(targetFolder))) {
        return currentItems;
      }

      if (targetFolderId !== null && isDocumentFolder(sourceItem) && documentTreeContainsId(sourceItem, targetFolderId)) {
        return currentItems;
      }

      const currentParentId = findDocumentParentFolderId(currentItems, itemId);
      if (currentParentId === targetFolderId) {
        return currentItems;
      }

      const detached = detachDocumentItem(currentItems, itemId);
      if (!detached.item) {
        return currentItems;
      }

      if (targetFolderId === null) {
        return appendDocumentItem(detached.items, null, detached.item);
      }

      const destinationAfterDetach = findDocumentItem(detached.items, targetFolderId);
      if (!destinationAfterDetach || !isDocumentFolder(destinationAfterDetach)) {
        return currentItems;
      }

      return appendDocumentItem(detached.items, targetFolderId, detached.item);
    });

    setActiveSection("documents");
    setSelectedSidebarItems((current) => ({
      ...current,
      documents: itemId
    }));
  };
  const handleDuplicateDocumentItem = (itemId: string) => {
    const sourceItem = findDocumentItem(documentsSidebarItems, itemId);
    if (!sourceItem) {
      return;
    }

    const parentFolderId = findDocumentParentFolderId(documentsSidebarItems, itemId);
    const duplicateItem = cloneDocumentItem(sourceItem);
    duplicateItem.label = `${sourceItem.label} copy`;

    setDocumentsSidebarItems((currentItems) => appendDocumentItem(currentItems, parentFolderId, duplicateItem));

    const clonedNotePairs = collectClonedNoteIdPairs(sourceItem, duplicateItem);
    if (typeof window !== "undefined") {
      for (const [sourceNoteId, clonedNoteId] of clonedNotePairs) {
        const sourceKey = getDocumentMarkdownStorageKey(sourceNoteId);
        const targetKey = getDocumentMarkdownStorageKey(clonedNoteId);
        const serializedMarkdown = window.localStorage.getItem(sourceKey);

        if (serializedMarkdown === null) {
          window.localStorage.removeItem(targetKey);
        } else {
          window.localStorage.setItem(targetKey, serializedMarkdown);
        }
      }
    }
    for (const [sourceNoteId, clonedNoteId] of clonedNotePairs) {
      void copyDocumentNoteFile(sourceNoteId, clonedNoteId, documentsBasePath);
    }
    setSelectedSidebarItems((current) => ({
      ...current,
      documents: duplicateItem.id
    }));
    setActiveSection("documents");
  };

  const handleCopyDocumentPath = (itemId: string) => {
    const pathSegments = findDocumentLabelPath(documentsSidebarItems, itemId);
    if (!pathSegments?.length) {
      return;
    }

    const path = pathSegments.join("/");
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(path).catch(() => {
        // Ignore clipboard failures in constrained runtimes.
      });
    }
  };

  const handleRenameDocumentItem = (itemId: string) => {
    const sourceItem = findDocumentItem(documentsSidebarItems, itemId);
    if (!sourceItem) {
      return;
    }

    setPendingRename({
      itemId,
      label: sourceItem.label,
      kind: isDocumentFolder(sourceItem) ? "folder" : "note",
      value: sourceItem.label
    });
  };

  const handleInlineRenameDocumentItem = (itemId: string, nextLabel: string) => {
    const trimmedLabel = nextLabel.trim();
    if (!trimmedLabel) {
      return;
    }

    setDocumentsSidebarItems((currentItems) => updateDocumentLabel(currentItems, itemId, trimmedLabel));
  };
  const handleConfirmRenameDocumentItem = () => {
    if (!pendingRename) {
      return;
    }

    const nextLabel = pendingRename.value.trim();
    if (!nextLabel) {
      return;
    }

    if (nextLabel !== pendingRename.label) {
      setDocumentsSidebarItems((currentItems) =>
        updateDocumentLabel(currentItems, pendingRename.itemId, nextLabel)
      );
    }

    setPendingRename(null);
  };

  const executeDeleteDocumentItem = (itemId: string) => {
    const sourceItem = findDocumentItem(documentsSidebarItems, itemId);
    if (!sourceItem) {
      return;
    }

    const removedNoteIds = collectDocumentNoteIds(sourceItem);
    const result = removeDocumentItem(documentsSidebarItems, itemId);
    if (!result.removedIds.length) {
      return;
    }

    setDocumentsSidebarItems(result.items);

    const removedIdSet = new Set(result.removedIds);

    if (typeof window !== "undefined") {
      for (const removedNoteId of removedNoteIds) {
        window.localStorage.removeItem(getDocumentMarkdownStorageKey(removedNoteId));
      }
    }
    for (const removedNoteId of removedNoteIds) {
      void deleteDocumentNoteFile(removedNoteId, documentsBasePath);
    }
    setSelectedSidebarItems((current) =>
      removedIdSet.has(current.documents)
        ? {
            ...current,
            documents: ""
          }
        : current
    );

    setTabs((currentTabs) => {
      const nextTabs = currentTabs.filter(
        (tab) => !(tab.kind === "document" && tab.documentItemId && removedIdSet.has(tab.documentItemId))
      );

      if (nextTabs.length === currentTabs.length) {
        return currentTabs;
      }

      if (!nextTabs.length) {
        const homeTab = createSectionTab("home");
        setActiveSection("home");
        setActiveTabId(homeTab.id);
        return [homeTab];
      }

      const activeRemoved = currentTabs.some(
        (tab) =>
          tab.id === activeTabId &&
          tab.kind === "document" &&
          tab.documentItemId &&
          removedIdSet.has(tab.documentItemId)
      );

      if (activeRemoved) {
        const fallbackTab =
          nextTabs.find((tab) => tab.kind === "section" && tab.sectionId === "documents") ?? nextTabs[0];

        setActiveTabId(fallbackTab.id);

        if (fallbackTab.kind === "section" && fallbackTab.sectionId) {
          setActiveSection(fallbackTab.sectionId);
        } else if (fallbackTab.kind === "document" && fallbackTab.documentItemId) {
          setActiveSection("documents");
          setSelectedSidebarItems((current) => ({
            ...current,
            documents: fallbackTab.documentItemId ?? current.documents
          }));
        }
      }

      return nextTabs;
    });
  };

  const handleDeleteDocumentItem = (itemId: string) => {
    const sourceItem = findDocumentItem(documentsSidebarItems, itemId);
    if (!sourceItem) {
      return;
    }

    setPendingDelete({
      itemId,
      label: sourceItem.label,
      kind: isDocumentFolder(sourceItem) ? "folder" : "note"
    });
  };

  const handleConfirmDeleteDocumentItem = () => {
    if (!pendingDelete) {
      return;
    }

    executeDeleteDocumentItem(pendingDelete.itemId);
    setPendingDelete(null);
  };

  useEffect(() => {
    if (!pendingDelete && !pendingRename) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPendingDelete(null);
        setPendingRename(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDelete, pendingRename]);

  useEffect(() => {
    setTabs((currentTabs) => {
      let changed = false;

      const nextTabs = currentTabs.map((tab) => {
        if (tab.kind !== "document" || !tab.documentItemId) {
          return tab;
        }

        const currentItem = findDocumentItem(documentsSidebarItems, tab.documentItemId);
        if (!currentItem || currentItem.label === tab.title) {
          return tab;
        }

        changed = true;
        return {
          ...tab,
          title: currentItem.label
        };
      });

      return changed ? nextTabs : currentTabs;
    });
  }, [documentsSidebarItems]);

  const activeTab =
    tabs.find((tab) => tab.id === activeTabId) ??
    tabs[0] ??
    createSectionTab(activeSection);
  const contentSection =
    activeTab.kind === "section"
      ? activeTab.sectionId ?? activeSection
      : activeTab.kind === "document"
        ? "documents"
        : activeSection;

  const activeDocumentNoteId = (() => {
    if (contentSection !== "documents") {
      return undefined;
    }

    if (activeTab.kind === "document" && activeTab.documentItemId) {
      const documentTabItem = findDocumentItem(documentsSidebarItems, activeTab.documentItemId);
      if (documentTabItem && isDocumentNote(documentTabItem)) {
        return documentTabItem.id;
      }
    }

    if (selectedDocumentItem && isDocumentNote(selectedDocumentItem)) {
      return selectedDocumentItem.id;
    }

    return undefined;
  })();

  const handleStartCodexSession = useCallback(() => {
    void (async () => {
      if (codexSession.status === "running" || codexSession.status === "starting") {
        return;
      }

      const commandPath = codexCommandPath.trim() || "codex";

      setBottomPanelOpen(true);
      setActiveBottomViewId("terminal");
      setCodexTerminalEntries([]);
      setCodexSession((current) => ({
        ...current,
        status: "starting",
        message: "Starting Codex process...",
        lastExitCode: null,
        terminalMode: codexDisableAltScreen ? "compact" : "full_screen",
        captureBundlePath: null,
        lastLifecyclePhase: null,
        lastResize: null
      }));

      if (!isTauriRuntime()) {
        setCodexSession((current) => ({
          ...current,
          status: "error",
          message: "Tauri runtime unavailable (web dev mode).",
          terminalMode: null
        }));
        appendTerminalEntry({
          sessionId: "local-preview",
          text: "\n[system] Tauri runtime unavailable, cannot spawn Codex here.\n"
        });
        return;
      }

      try {
        const response = await invoke<SpawnCodexProcessResponse>("spawn_codex_process", {
          request: {
            workspace_path: workspace.rootPath,
            command: commandPath,
            args: codexDisableAltScreen ? ["--no-alt-screen"] : [],
            capture_debug_bundle: codexCaptureDebugBundle
          }
        });

        setCodexSession({
          sessionId: response.session_id,
          status: "running",
          message: response.capture_bundle_path
            ? `${response.message} Capture bundle: ${response.capture_bundle_path}`
            : response.message,
          lastExitCode: null,
          terminalMode: response.terminal_mode,
          captureBundlePath: response.capture_bundle_path ?? null,
          lastLifecyclePhase: "session_started",
          lastResize: null
        });
        setCodexTerminalHostInfo(mapTerminalHostInfo(response.terminal_host));

        if (response.capture_bundle_path) {
          appendTerminalEntry({
            sessionId: response.session_id,
            text: `\n[system] Debug capture bundle: ${response.capture_bundle_path}\n`
          });
        }
      } catch (error) {
        const message = `Failed to start Codex: ${String(error)}`;
        setCodexSession((current) => ({
          ...current,
          status: "error",
          message
        }));

        appendTerminalEntry({
          sessionId: codexSession.sessionId ?? "unknown",
          text: `\n[system] ${message}\n`
        });
      }
    })();
  }, [
    appendTerminalEntry,
    codexCaptureDebugBundle,
    codexCommandPath,
    codexDisableAltScreen,
    codexSession.sessionId,
    codexSession.status,
    workspace.rootPath
  ]);

  const handleStopCodexSession = useCallback(() => {
    void (async () => {
      if (!codexSession.sessionId) {
        return;
      }

      setCodexSession((current) => ({
        ...current,
        status: "stopping",
        message: "Stopping Codex process..."
      }));

      try {
        const response = await invoke<OperationAck>("stop_codex_process", {
          request: {
            session_id: codexSession.sessionId
          }
        });

        appendTerminalEntry({
          sessionId: codexSession.sessionId,
          text: `\n[system] ${response.message}\n`
        });
      } catch (error) {
        const message = `Failed to stop Codex: ${String(error)}`;
        setCodexSession((current) => ({
          ...current,
          status: "error",
          message
        }));

        appendTerminalEntry({
          sessionId: codexSession.sessionId,
          text: `\n[system] ${message}\n`
        });
      }
    })();
  }, [appendTerminalEntry, codexSession.sessionId]);

  const handleSendCodexInput = useCallback(
    (input: string) => {
      void (async () => {
        if (!codexSession.sessionId || codexSession.status !== "running") {
          return;
        }

        try {
          await invoke<OperationAck>("send_codex_input", {
            request: {
              session_id: codexSession.sessionId,
              input
            }
          });
        } catch (error) {
          appendTerminalEntry({
            sessionId: codexSession.sessionId,
            text: `\n[system] Failed to send input: ${String(error)}\n`
          });
        }
      })();
    },
    [appendTerminalEntry, codexSession.sessionId, codexSession.status]
  );


  const handleResizeCodexTerminal = useCallback(
    (cols: number, rows: number) => {
      void (async () => {
        if (!codexSession.sessionId || codexSession.status !== "running") {
          return;
        }

        try {
          await invoke<OperationAck>("resize_codex_terminal", {
            request: {
              session_id: codexSession.sessionId,
              cols,
              rows
            }
          });
        } catch {
          // Resize events are frequent and best-effort only.
        }
      })();
    },
    [codexSession.sessionId, codexSession.status]
  );
  const handleClearTerminal = useCallback(() => {
    setCodexTerminalEntries([]);
    setCodexTerminalClearSignal((current) => current + 1);
  }, []);

  useEffect(() => {
    if (contentSection === "codex" && codexSession.sessionId) {
      setActiveBottomViewId("terminal");
    }
  }, [codexSession.sessionId, contentSection]);

  const inspectorSections = useMemo<InspectorSection[]>(() => {
    const latestRun = sortedRuns[0];

    if (contentSection === "home") {
      return [
        {
          id: "home-context",
          title: "Review state",
          rows: [
            { label: "Needs review", value: String(runStats.openReviewCount), tone: "warning" },
            { label: "Running", value: String(runStats.runningCount) },
            { label: "Artifacts", value: String(artifactCount) }
          ]
        },
        {
          id: "home-latest",
          title: "Latest run",
          rows: latestRun
            ? [
                { label: "Name", value: latestRun.title },
                { label: "Status", value: statusLabels[latestRun.status], tone: statusTone[latestRun.status] },
                { label: "Started", value: new Date(latestRun.startedAt).toLocaleString() }
              ]
            : [{ label: "Status", value: "No runs yet", tone: "neutral" }]
        }
      ];
    }

    if (contentSection === "runs") {
      const run = sortedRuns[0];
      return [
        {
          id: "runs-selection",
          title: "Selected run",
          rows: run
            ? [
                { label: "Title", value: run.title },
                { label: "Type", value: run.type.replace("_", " ") },
                { label: "Status", value: statusLabels[run.status], tone: statusTone[run.status] }
              ]
            : [{ label: "Selection", value: "No run selected", tone: "neutral" }]
        },
        {
          id: "runs-extraction",
          title: "Extraction checks",
          rows: [
            { label: "Decisions", value: "2 detected", tone: "neutral" },
            { label: "Action items", value: "3 pending owner review", tone: "warning" },
            { label: "Confidence", value: "Medium", tone: "neutral" }
          ]
        }
      ];
    }

    if (contentSection === "documents") {
      return [
        {
          id: "documents-context",
          title: "Document context",
          rows: [
            { label: "Mode", value: "Markdown editor" },
            { label: "Selection", value: selectedDocumentFolderLabel ?? "None" },
            { label: "Rendering", value: "Live preview with GFM" }
          ]
        },
        {
          id: "documents-capabilities",
          title: "Capabilities",
          rows: [
            { label: "Blocks", value: "Headings, quotes, code, tables" },
            { label: "Lists", value: "Bullets, numbered, checklists" },
            { label: "Links", value: "Inline markdown link support" }
          ]
        }
      ];
    }
    if (contentSection === "vault") {
      return [
        {
          id: "vault-state",
          title: "Vault context",
          rows: [
            { label: "Vault path", value: workspace.obsidian.vaultPath },
            { label: "Publish folder", value: workspace.obsidian.publishFolder },
            { label: "Safe mode", value: workspace.obsidian.safeMode ? "Enabled" : "Disabled" }
          ]
        },
        {
          id: "vault-warnings",
          title: "Warnings",
          rows: [{ label: "Overwrite protection", value: "Review required before publish", tone: "warning" }]
        }
      ];
    }

    if (contentSection === "codex") {
      return [
        {
          id: "codex-session",
          title: "Session metadata",
          rows: [
            { label: "Workspace", value: workspace.rootPath },
            { label: "Session", value: codexSession.sessionId ?? "None" },
            { label: "Status", value: codexSession.status },
            {
              label: "Terminal mode",
              value:
                codexSession.terminalMode === "compact"
                  ? "Compact fallback"
                  : codexSession.terminalMode === "full_screen"
                    ? "Full-screen primary"
                    : "Not started"
            },
            {
              label: "PTY host",
              value: codexTerminalHostInfo?.windowsPty
                ? `${codexTerminalHostInfo.windowsPty.backend} ${codexTerminalHostInfo.windowsPty.buildNumber ?? ""}`.trim()
                : "Unavailable"
            }
          ]
        },
        {
          id: "codex-next",
          title: "Bridge state",
          rows: [
            { label: "System entries", value: String(codexTerminalEntries.length) },
            { label: "Last exit", value: codexSession.lastExitCode === null ? "N/A" : String(codexSession.lastExitCode) },
            { label: "Lifecycle", value: codexSession.lastLifecyclePhase ?? "idle" },
            {
              label: "Last size",
              value: codexSession.lastResize ? `${codexSession.lastResize.cols}x${codexSession.lastResize.rows}` : "N/A"
            },
            { label: "Capture", value: codexSession.captureBundlePath ?? "Disabled" }
          ]
        }
      ];
    }
    if (contentSection === "settings") {
      return [
        {
          id: "settings-selected",
          title: "Selection",
          rows: [{ label: "Category", value: selectedSidebarItemId.replace("settings-", "") }]
        },
        {
          id: "settings-theme",
          title: "Display",
          rows: [
            { label: "Theme", value: theme === "dark" ? "Dark" : "Light" },
            { label: "Density", value: "Compact desktop" }
          ]
        }
      ];
    }

    return [
      {
        id: "generic-context",
        title: "Context",
        rows: [
          { label: "Section", value: sectionTitles[contentSection] },
          { label: "Sidebar selection", value: selectedSidebarItemId || "None" }
        ]
      }
    ];
  }, [
    codexSession,
    codexTerminalEntries.length,
    codexTerminalHostInfo,
    contentSection,
    runStats,
    selectedDocumentFolderLabel,
    selectedSidebarItemId,
    sortedRuns,
    theme,
    workspace
  ]);

  const bottomPanelViews = useMemo<BottomPanelView[]>(() => {
    const views: BottomPanelView[] = [
      {
        id: "status",
        label: "Status",
        lines: [
          `[status] Section: ${sectionTitles[contentSection]}`,
          `[status] Sidebar: ${sidebarCollapsed ? "collapsed" : "open"} (${Math.round(sidebarWidth)}px)`,
          `[status] Inspector: ${inspectorOpen ? "open" : "closed"} (${Math.round(inspectorWidth)}px)`,
          `[status] Bottom panel: ${bottomPanelOpen ? "open" : "closed"} (${Math.round(effectiveBottomPanelHeight)}px)`
        ]
      },
      {
        id: "logs",
        label: "Logs",
        lines: [
          "[log] Meeting import and recording now create persisted runs.",
          "[log] OpenAI transcription and cleanup write raw and cleaned transcript artifacts.",
          "[log] Review-first publish flow remains UI scaffold only.",
          "[log] Theme tokens loaded from centralized CSS variables."
        ]
      },
      {
        id: "codex",
        label: "Codex output",
        lines: [
          "$ codex --workspace .",
          "Interactive stream is now available in the Terminal tab on the Codex screen.",
          `Session status: ${codexSession.status}`,
          `Terminal mode: ${
            codexSession.terminalMode === "compact"
              ? "Compact fallback"
              : codexSession.terminalMode === "full_screen"
                ? "Full-screen primary"
                : "Not started"
          }`
        ]
      }
    ];

    if (contentSection === "codex") {
      views.push({
        id: "terminal",
        label: "Terminal",
        content: (
          <CodexTerminalPanel
            session={codexSession}
            terminalHostInfo={codexTerminalHostInfo}
            entries={codexTerminalEntries}
            clearSignal={codexTerminalClearSignal}
            captureEnabled={codexCaptureDebugBundle}
            onStart={handleStartCodexSession}
            onStop={handleStopCodexSession}
            onClear={handleClearTerminal}
            onSendInput={handleSendCodexInput}
            onResizeTerminal={handleResizeCodexTerminal}
          />
        )
      });
    }

    return views;
  }, [
    effectiveBottomPanelHeight,
    bottomPanelOpen,
    codexCaptureDebugBundle,
    codexTerminalHostInfo,
    codexSession,
    codexTerminalClearSignal,
    codexTerminalEntries,
    contentSection,
    handleClearTerminal,
    handleSendCodexInput,
    handleResizeCodexTerminal,
    handleStartCodexSession,
    handleStopCodexSession,
    inspectorOpen,
    inspectorWidth,
    sidebarCollapsed,
    sidebarWidth
  ]);

  useEffect(() => {
    if (!bottomPanelViews.some((view) => view.id === activeBottomViewId)) {
      setActiveBottomViewId(bottomPanelViews[0]?.id ?? "status");
    }
  }, [activeBottomViewId, bottomPanelViews]);

  const utilityActions: RibbonUtilityAction[] = [
    {
      id: "sidebar-toggle",
      label: sidebarCollapsed ? "Open sidebar (Ctrl/Cmd+B)" : "Collapse sidebar (Ctrl/Cmd+B)",
      icon: <PanelLeftIcon />,
      active: !sidebarCollapsed,
      onClick: () => setSidebarCollapsed((current) => !current)
    },
    {
      id: "bottom-toggle",
      label: bottomPanelOpen ? "Close bottom panel (Ctrl/Cmd+J)" : "Open bottom panel (Ctrl/Cmd+J)",
      icon: <PanelBottomIcon />,
      active: bottomPanelOpen,
      onClick: () => setBottomPanelOpen((current) => !current)
    },
    {
      id: "theme-toggle",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: theme === "dark" ? <SunIcon /> : <MoonIcon />,
      onClick: () => setTheme((current) => (current === "dark" ? "light" : "dark"))
    }
  ];

  const openSection = (sectionId: SectionId) => {
    setActiveSection(sectionId);
    const existing = tabs.find((tab) => tab.kind === "section" && tab.sectionId === sectionId);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const nextTab = createSectionTab(sectionId);
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const createScratchTab = () => {
    const existingScratchCount = tabs.filter((tab) => tab.kind === "scratch").length;
    const nextTab: WorkspaceTabState = {
      id: `scratch-${Date.now()}`,
      title: `Scratch ${existingScratchCount + 1}`,
      kind: "scratch",
      closable: true,
      pinned: false
    };
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const toggleTabPin = (tabId: string) => {
    setTabs((currentTabs) =>
      currentTabs.map((tab) => (tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab))
    );
  };

  const duplicateTab = (tabId: string) => {
    setTabs((currentTabs) => {
      const tabIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) {
        return currentTabs;
      }

      const sourceTab = currentTabs[tabIndex];
      const duplicate: WorkspaceTabState = {
        ...sourceTab,
        id:
          sourceTab.kind === "document" && sourceTab.documentItemId
            ? `tab-document-${sourceTab.documentItemId}-${Date.now()}`
            : sourceTab.kind === "section" && sourceTab.sectionId
              ? `tab-section-${sourceTab.sectionId}-${Date.now()}`
              : `scratch-${Date.now()}`
      };

      const nextTabs = [...currentTabs];
      nextTabs.splice(tabIndex + 1, 0, duplicate);
      setActiveTabId(duplicate.id);

      if (duplicate.kind === "section" && duplicate.sectionId) {
        setActiveSection(duplicate.sectionId);
      } else if (duplicate.kind === "document" && duplicate.documentItemId) {
        setActiveSection("documents");
        setSelectedSidebarItems((current) => ({
          ...current,
          documents: duplicate.documentItemId ?? current.documents
        }));
      }

      return nextTabs;
    });
  };

  const closeTab = (tabId: string) => {
    setTabs((currentTabs) => {
      const tabIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) {
        return currentTabs;
      }

      const tab = currentTabs[tabIndex];
      if (!tab.closable) {
        return currentTabs;
      }

      const nextTabs = currentTabs.filter((entry) => entry.id !== tabId);
      const fallbackTab = nextTabs[Math.max(0, tabIndex - 1)] ?? nextTabs[0];
      if (!fallbackTab) {
        const homeTab = createSectionTab("home");
        setActiveSection("home");
        setActiveTabId(homeTab.id);
        return [homeTab];
      }

      if (tabId === activeTabId) {
        setActiveTabId(fallbackTab.id);
        if (fallbackTab.kind === "section" && fallbackTab.sectionId) {
          setActiveSection(fallbackTab.sectionId);
        } else if (fallbackTab.kind === "document" && fallbackTab.documentItemId) {
          setActiveSection("documents");
          setSelectedSidebarItems((current) => ({
            ...current,
            documents: fallbackTab.documentItemId ?? current.documents
          }));
        }
      }

      return nextTabs;
    });
  };

  const selectTab = (tabId: string) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }

    setActiveTabId(tabId);
    if (tab.kind === "section" && tab.sectionId) {
      setActiveSection(tab.sectionId);
      return;
    }

    if (tab.kind === "document" && tab.documentItemId) {
      setActiveSection("documents");
      setSelectedSidebarItems((current) => ({
        ...current,
        documents: tab.documentItemId ?? current.documents
      }));
    }
  };

  const reorderTabs = (draggedTabId: string, targetTabId: string, placement: "before" | "after") => {
    if (draggedTabId === targetTabId) {
      return;
    }

    setTabs((currentTabs) => {
      const draggedTab = currentTabs.find((tab) => tab.id === draggedTabId);
      if (!draggedTab) {
        return currentTabs;
      }

      const withoutDragged = currentTabs.filter((tab) => tab.id !== draggedTabId);
      const targetIndex = withoutDragged.findIndex((tab) => tab.id === targetTabId);
      if (targetIndex === -1) {
        return currentTabs;
      }

      const insertIndex = placement === "after" ? targetIndex + 1 : targetIndex;
      withoutDragged.splice(insertIndex, 0, draggedTab);
      return withoutDragged;
    });
  };

  const beginSidebarResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (sidebarCollapsed) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.style.cursor = "col-resize";

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.round(clamp(startWidth + (moveEvent.clientX - startX), 180, 360));
      setSidebarWidth(nextWidth);
    };

    const onMouseUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const beginInspectorResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!inspectorOpen) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    document.body.style.cursor = "col-resize";

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.round(clamp(startWidth - (moveEvent.clientX - startX), 220, 340));
      setInspectorWidth(nextWidth);
    };

    const onMouseUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const beginBottomResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!bottomPanelOpen) {
      return;
    }

    event.preventDefault();
    const startY = event.clientY;
    const startHeight = effectiveBottomPanelHeight;
    document.body.style.cursor = "row-resize";

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextHeight = clampBottomPanelHeight(startHeight + (startY - moveEvent.clientY), window.innerHeight);
      setBottomPanelHeight(nextHeight);
    };

    const onMouseUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const settingsCategory = selectedSidebarItemId.startsWith("settings-")
    ? selectedSidebarItemId
    : "settings-general";

  const renderSectionContent = (sectionId: SectionId) => {
    if (sectionId === "home") {
      return <HomeScreen workspace={workspace} runs={sortedRuns} stats={runStats} />;
    }

    if (sectionId === "meetings") {
      return (
        <MeetingsScreen
          workspace={workspace}
          runs={meetingRuns}
          loading={meetingRunsLoading}
          actionMessage={meetingActionMessage}
          onImportFile={handleImportMeetingFile}
          onStartRecording={handleStartMeetingRecording}
          onStopRecording={handleStopMeetingRecording}
          onRetranscribeRun={handleRetranscribeMeetingRun}
          onDeleteTranscripts={handleDeleteMeetingTranscripts}
          onDeleteRun={handleDeleteMeetingRun}
          onRefresh={refreshMeetingRuns}
        />
      );
    }

    if (sectionId === "documents") {
      return <DocumentsScreen key={activeDocumentNoteId ?? "documents-no-note"} theme={theme} noteId={activeDocumentNoteId} documentsBasePath={documentsBasePath} editorFont={documentsEditorFont} />;
    }
    if (sectionId === "runs") {
      return <RunsScreen runs={sortedRuns} />;
    }

    if (sectionId === "vault") {
      return <VaultScreen workspace={workspace} runs={sortedRuns} />;
    }

    if (sectionId === "codex") {
      return <CodexScreen workspace={workspace} />;
    }

    return (
      <SettingsScreen
        workspace={workspace}
        selectedCategory={settingsCategory}
        codexCommandPath={codexCommandPath}
        codexDisableAltScreen={codexDisableAltScreen}
        codexCaptureDebugBundle={codexCaptureDebugBundle}
        documentsOpenInNewTab={documentsOpenInNewTab}
        documentsBasePath={documentsBasePath}
        documentsEditorFont={documentsEditorFont}
        transcriptionSettings={transcriptionSettings}
        transcriptionStatusMessage={transcriptionStatusMessage}
        onCodexCommandPathChange={setCodexCommandPath}
        onCodexDisableAltScreenChange={setCodexDisableAltScreen}
        onCodexCaptureDebugBundleChange={setCodexCaptureDebugBundle}
        onDocumentsOpenInNewTabChange={setDocumentsOpenInNewTab}
        onDocumentsBasePathChange={setDocumentsBasePath}
        onDocumentsEditorFontChange={setDocumentsEditorFont}
        onSaveTranscriptionSettings={handleSaveTranscriptionSettings}
      />
    );
  };

  const renderWorkspaceContent = () => {
    if (activeTab.kind === "scratch") {
      return (
        <section className="workspace-screen">
          <header className="pane-header">
            <p className="pane-eyebrow">Scratch</p>
            <h2 className="pane-title">{activeTab.title}</h2>
            <p className="pane-subtitle">
              Empty workspace tab for notes, temporary prompts, or command prep.
            </p>
          </header>
          <article className="pane-block">
            <p className="muted">
              This tab intentionally has no workflow binding yet. Future versions can support split panes,
              file-backed scratch buffers, and pinning.
            </p>
          </article>
        </section>
      );
    }

    return renderSectionContent(contentSection);
  };

  return (
    <>
      <AppShell
      sidebarCollapsed={sidebarCollapsed}
      sidebarWidth={sidebarWidth}
        inspectorOpen={inspectorOpen}
        inspectorWidth={inspectorWidth}
        bottomPanelOpen={bottomPanelOpen}
        bottomPanelHeight={effectiveBottomPanelHeight}
        onSidebarResizeStart={beginSidebarResize}
        onInspectorResizeStart={beginInspectorResize}
        onBottomPanelResizeStart={beginBottomResize}
      rail={
        <RibbonRail
          sections={railSections}
          activeSectionId={activeSection}
          onSelectSection={(sectionId) => openSection(sectionId as SectionId)}
          utilityActions={utilityActions.filter((a) => a.id !== "sidebar-toggle")}
        />
      }
      leftHeader={
        <header className="left-pane-header">
          <div className="left-pane-header-rail">
            <button
              type="button"
              className="left-pane-toggle"
              onClick={() => setSidebarCollapsed((current) => !current)}
              title={sidebarCollapsed ? "Show sidebar (Ctrl/Cmd+B)" : "Hide sidebar (Ctrl/Cmd+B)"}
              aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            >
              <PanelLeftIcon />
            </button>
          </div>
          <div className="left-pane-header-sidebar" aria-hidden={sidebarCollapsed}>
            <p className="sidebar-title">{sectionTitles[activeSection]}</p>
          </div>
        </header>
      }
      sidebar={
        activeSection === "documents" ? (
          <DocumentsSidebar
            collapsed={sidebarCollapsed}
            folders={documentsSidebarItems}
            selectedItemId={selectedSidebarItemId}
            onSelectItem={(itemId) =>
              setSelectedSidebarItems((current) => ({
                ...current,
                [activeSection]: itemId
              }))
            }
            onOpenNote={handleOpenDocumentFromSidebar}
            onCreateNote={handleCreateDocumentNote}
            onCreateFolder={handleCreateDocumentFolder}
            onOpenInNewTab={handleOpenDocumentInNewTab}
            onDuplicateItem={handleDuplicateDocumentItem}
            onCopyPath={handleCopyDocumentPath}
            onRenameItem={handleRenameDocumentItem}
            onInlineRenameItem={handleInlineRenameDocumentItem}
            onDeleteItem={handleDeleteDocumentItem}
            onClearSelection={() =>
              setSelectedSidebarItems((current) => ({
                ...current,
                documents: ""
              }))
            }
            onMoveItem={handleMoveDocumentItem}
          />
        ) : (
          <CollapsibleSidebar
            collapsed={sidebarCollapsed}
            groups={activeSidebarGroups}
            selectedItemId={selectedSidebarItemId}
            onSelectItem={(itemId) =>
              setSelectedSidebarItems((current) => ({
                ...current,
                [activeSection]: itemId
              }))
            }
          />
        )
      }
      topRightControls={<WindowTitleBar inspectorOpen={inspectorOpen} onToggleInspector={() => setInspectorOpen((current) => !current)} />}
      workspace={
        <WorkspacePane
          tabs={tabs}
          activeTabId={activeTab.id}
          onSelectTab={selectTab}
          onCloseTab={closeTab}
          onToggleTabPin={toggleTabPin}
          onDuplicateTab={duplicateTab}
          onCreateTab={createScratchTab}
          onReorderTabs={reorderTabs}
        >
          {renderWorkspaceContent()}
        </WorkspacePane>
      }
      inspector={<InspectorPane title={sectionTitles[contentSection]} sections={inspectorSections} />}
      bottomPanel={
        <BottomPanel
          views={bottomPanelViews}
          activeViewId={activeBottomViewId}
          onSelectView={setActiveBottomViewId}
        />
      }
    >
      <footer className="shell-status muted">
        <FolderIcon />
        <span>
          Workspace: {workspace.name} - Local artifacts: {artifactCount}
        </span>
      </footer>
    </AppShell>
    {pendingRename ? (
      <RenameDialog
        title={`Rename ${pendingRename.kind}`}
        value={pendingRename.value}
        confirmLabel="Rename"
        cancelLabel="Cancel"
        onValueChange={(value) =>
          setPendingRename((current) => (current ? { ...current, value } : current))
        }
        onConfirm={handleConfirmRenameDocumentItem}
        onCancel={() => setPendingRename(null)}
      />
    ) : null}

    {pendingDelete ? (
      <ConfirmDialog
        title={`Delete ${pendingDelete.kind}`}
        message={`Are you sure you want to delete "${pendingDelete.label}"?`}
        description={
          pendingDelete.kind === "folder"
            ? "This folder and all nested items will be removed."
            : "This note will be removed."
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={handleConfirmDeleteDocumentItem}
        onCancel={() => setPendingDelete(null)}
      />
    ) : null}
    </>
  );
}

export default App;



































