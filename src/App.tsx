import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AppShell } from "./components/AppShell";
import { BottomPanel, type BottomPanelView } from "./components/shell/BottomPanel";
import { ConfirmDialog } from "./components/shell/ConfirmDialog";
import {
  CodexTerminalPanel,
  type CodexSessionState,
  type CodexTerminalEntry,
  type CodexTerminalStream
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
import { artifacts, runs, workspaces } from "./data/mockData";
import { useLocalStorageState } from "./hooks/useLocalStorageState";
import type { Run, RunStatus } from "./models/run";
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

interface SpawnCodexProcessResponse {
  session_id: string;
  status: string;
  message: string;
}

interface OperationAck {
  ok: boolean;
  message: string;
}


interface TerminalExitEventPayload {
  session_id: string;
  code: number | null;
}

const TERMINAL_EXIT_EVENT = "codex://terminal-exit";

interface WorkspaceTabState {
  id: string;
  title: string;
  kind: "section" | "scratch" | "document";
  sectionId?: SectionId;
  documentItemId?: string;
  closable: boolean;
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
  needs_review: "Needs review",
  completed: "Completed",
  failed: "Failed"
};

const statusTone: Record<RunStatus, "neutral" | "warning" | "success" | "danger"> = {
  queued: "neutral",
  running: "neutral",
  needs_review: "warning",
  completed: "success",
  failed: "danger"
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createSectionTab(sectionId: SectionId): WorkspaceTabState {
  return {
    id: `tab-${sectionId}`,
    title: sectionTitles[sectionId],
    kind: "section",
    sectionId,
    closable: true
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

  const [codexSession, setCodexSession] = useState<CodexSessionState>({
    sessionId: null,
    status: "idle",
    message: "Ready",
    lastExitCode: null
  });
  const [codexTerminalEntries, setCodexTerminalEntries] = useState<CodexTerminalEntry[]>([]);
  const [codexTerminalClearSignal, setCodexTerminalClearSignal] = useState(0);
  const [codexCommandPath, setCodexCommandPath] = useLocalStorageState<string>(
    "settings.codex.commandPath",
    "codex"
  );
  const [codexDisableAltScreen, setCodexDisableAltScreen] = useLocalStorageState<boolean>(
    "settings.codex.disableAltScreen",
    true
  );
  const sortedRuns = useMemo(() => sortRunsByStartedAt(runs), []);

  const runStats = useMemo(
    () => ({
      total: runs.length,
      openReviewCount: runs.filter((run) => run.status === "needs_review").length,
      runningCount: runs.filter((run) => run.status === "running").length
    }),
    []
  );

  const appendTerminalEntry = useCallback((entry: CodexTerminalEntry) => {
    setCodexTerminalEntries((current) => [...current.slice(-499), entry]);
  }, []);

  const sidebarGroupsBySection = useMemo<Record<SectionId, SidebarGroupData[]>>(() => {
    const recentMeetingRuns = sortedRuns.filter(
      (run) => run.type === "meeting_import" || run.type === "meeting_recording"
    );
    const runningRuns = sortedRuns.filter((run) => run.status === "running");
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
          closable: true
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

    const unlistenFns: UnlistenFn[] = [];
    let disposed = false;

    const attachListeners = async () => {
      try {
        const unlistenExit = await listen<TerminalExitEventPayload>(TERMINAL_EXIT_EVENT, (event) => {
          setCodexSession((current) => {
            if (current.sessionId !== event.payload.session_id) {
              return current;
            }

            return {
              sessionId: current.sessionId,
              status: "stopped",
              message: `Process exited${event.payload.code === null ? "" : ` with code ${event.payload.code}`}.`,
              lastExitCode: event.payload.code
            };
          });

          appendTerminalEntry({
            sessionId: event.payload.session_id,
            stream: "system",
            chunk:
              event.payload.code === null
                ? "\n[system] Codex process exited.\n"
                : `\n[system] Codex process exited with code ${event.payload.code}.\n`
          });
        });

        if (disposed) {
          unlistenExit();
          return;
        }

        unlistenFns.push(unlistenExit);
      } catch (error) {
        appendTerminalEntry({
          sessionId: "unknown",
          stream: "system",
          chunk: `\n[system] Failed to register terminal listeners: ${String(error)}\n`
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

  const activeSidebarGroups = sidebarGroupsBySection[activeSection];
  const selectedSidebarItemId = (() => {
    const storedSelection = selectedSidebarItems[activeSection];
    if (activeSection === "documents") {
      if (storedSelection && findDocumentItem(documentsSidebarItems, storedSelection)) {
        return storedSelection;
      }

      return documentsSidebarItems[0]?.id ?? "";
    }

    return storedSelection ?? activeSidebarGroups[0]?.items[0]?.id ?? "";
  })();

  const selectedDocumentItem = selectedSidebarItemId
    ? findDocumentItem(documentsSidebarItems, selectedSidebarItemId)
    : undefined;
  const selectedDocumentFolderLabel = selectedDocumentItem?.label;

  const createDocumentItem = (kind: "note" | "folder", parentFolderId?: string) => {
    const nextId = createDocumentItemId(kind);

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

      const nextNumber = countDocumentItemsByKind(currentItems, kind) + 1;
      const nextItem: DocumentTreeItem =
        kind === "folder"
          ? { id: nextId, label: `New folder ${nextNumber}`, kind: "folder", children: [] }
          : { id: nextId, label: `New note ${nextNumber}`, kind: "note" };

      return appendDocumentItem(currentItems, resolvedParentFolderId, nextItem);
    });

    setSelectedSidebarItems((current) => ({
      ...current,
      documents: nextId
    }));
    setActiveSection("documents");
  };

  const handleCreateDocumentNote = (parentFolderId?: string) => createDocumentItem("note", parentFolderId);
  const handleCreateDocumentFolder = (parentFolderId?: string) =>
    createDocumentItem("folder", parentFolderId);

  const handleOpenDocumentInNewTab = (itemId: string) => {
    const item = findDocumentItem(documentsSidebarItems, itemId);
    if (!item || isDocumentFolder(item)) {
      return;
    }

    const nextTab: WorkspaceTabState = {
      id: `tab-document-${itemId}-${Date.now()}`,
      title: item.label,
      kind: "document",
      documentItemId: item.id,
      closable: true
    };

    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
    setActiveSection("documents");
    setSelectedSidebarItems((current) => ({
      ...current,
      documents: item.id
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

    const nextLabel = window.prompt("Rename", sourceItem.label)?.trim();
    if (!nextLabel || nextLabel === sourceItem.label) {
      return;
    }

    setDocumentsSidebarItems((currentItems) => updateDocumentLabel(currentItems, itemId, nextLabel));
  };

  const executeDeleteDocumentItem = (itemId: string) => {
    const sourceItem = findDocumentItem(documentsSidebarItems, itemId);
    if (!sourceItem) {
      return;
    }

    const result = removeDocumentItem(documentsSidebarItems, itemId);
    if (!result.removedIds.length) {
      return;
    }

    setDocumentsSidebarItems(result.items);

    const removedIdSet = new Set(result.removedIds);
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
    if (!pendingDelete) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPendingDelete(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDelete]);

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

  const handleStartCodexSession = useCallback(() => {
    void (async () => {
      if (codexSession.status === "running" || codexSession.status === "starting") {
        return;
      }

      const commandPath = codexCommandPath.trim() || "codex";

      setBottomPanelOpen(true);
      setActiveBottomViewId("terminal");
      setCodexSession((current) => ({
        ...current,
        status: "starting",
        message: "Starting Codex process...",
        lastExitCode: null
      }));

      if (!isTauriRuntime()) {
        setCodexSession((current) => ({
          ...current,
          status: "error",
          message: "Tauri runtime unavailable (web dev mode)."
        }));
        appendTerminalEntry({
          sessionId: "local-preview",
          stream: "system",
          chunk: "\n[system] Tauri runtime unavailable, cannot spawn Codex here.\n"
        });
        return;
      }

      try {
        const response = await invoke<SpawnCodexProcessResponse>("spawn_codex_process", {
          request: {
            workspace_path: workspace.rootPath,
            command: commandPath,
            args: codexDisableAltScreen ? ["--no-alt-screen"] : []
          }
        });

        setCodexSession({
          sessionId: response.session_id,
          status: "running",
          message: response.message,
          lastExitCode: null
        });
      } catch (error) {
        const message = `Failed to start Codex: ${String(error)}`;
        setCodexSession((current) => ({
          ...current,
          status: "error",
          message
        }));

        appendTerminalEntry({
          sessionId: codexSession.sessionId ?? "unknown",
          stream: "system",
          chunk: `\n[system] ${message}\n`
        });
      }
    })();
  }, [appendTerminalEntry, codexCommandPath, codexDisableAltScreen, codexSession.sessionId, codexSession.status, workspace.rootPath]);

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
          stream: "system",
          chunk: `\n[system] ${response.message}\n`
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
          stream: "system",
          chunk: `\n[system] ${message}\n`
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
            stream: "system",
            chunk: `\n[system] Failed to send input: ${String(error)}\n`
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
            { label: "Artifacts", value: String(artifacts.length) }
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
            { label: "Output mode", value: "Bottom panel terminal stream" }
          ]
        },
        {
          id: "codex-next",
          title: "Bridge state",
          rows: [
            { label: "System entries", value: String(codexTerminalEntries.length) },
            { label: "Last exit", value: codexSession.lastExitCode === null ? "N/A" : String(codexSession.lastExitCode) }
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
  }, [contentSection, runStats, selectedDocumentFolderLabel, selectedSidebarItemId, sortedRuns, theme, workspace]);

  const bottomPanelViews = useMemo<BottomPanelView[]>(() => {
    const views: BottomPanelView[] = [
      {
        id: "status",
        label: "Status",
        lines: [
          `[status] Section: ${sectionTitles[contentSection]}`,
          `[status] Sidebar: ${sidebarCollapsed ? "collapsed" : "open"} (${Math.round(sidebarWidth)}px)`,
          `[status] Inspector: ${inspectorOpen ? "open" : "closed"} (${Math.round(inspectorWidth)}px)`,
          `[status] Bottom panel: ${bottomPanelOpen ? "open" : "closed"} (${Math.round(bottomPanelHeight)}px)`
        ]
      },
      {
        id: "logs",
        label: "Logs",
        lines: [
          "[log] Ready for recording/import workflow hooks.",
          "[log] Transcription provider boundary not implemented in this task.",
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
          `Session status: ${codexSession.status}`
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
            entries={codexTerminalEntries}
            clearSignal={codexTerminalClearSignal}
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
    bottomPanelHeight,
    bottomPanelOpen,
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
      closable: true
    };
    setTabs((currentTabs) => [...currentTabs, nextTab]);
    setActiveTabId(nextTab.id);
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
      const nextWidth = Math.round(clamp(startWidth + (moveEvent.clientX - startX), 220, 360));
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
      const nextWidth = Math.round(clamp(startWidth - (moveEvent.clientX - startX), 260, 340));
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
    const startHeight = bottomPanelHeight;
    document.body.style.cursor = "row-resize";

    const onMouseMove = (moveEvent: MouseEvent) => {
      const maxBottomHeight = Math.max(220, window.innerHeight - 140);
      const nextHeight = Math.round(clamp(startHeight + (startY - moveEvent.clientY), 140, maxBottomHeight));
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
      return <MeetingsScreen runs={sortedRuns} />;
    }

    if (sectionId === "documents") {
      return <DocumentsScreen theme={theme} />;
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
        onCodexCommandPathChange={setCodexCommandPath}
        onCodexDisableAltScreenChange={setCodexDisableAltScreen}
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
      bottomPanelHeight={bottomPanelHeight}
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
            onCreateNote={handleCreateDocumentNote}
            onCreateFolder={handleCreateDocumentFolder}
            onOpenInNewTab={handleOpenDocumentInNewTab}
            onDuplicateItem={handleDuplicateDocumentItem}
            onCopyPath={handleCopyDocumentPath}
            onRenameItem={handleRenameDocumentItem}
            onDeleteItem={handleDeleteDocumentItem}
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
          Workspace: {workspace.name} - Local artifacts: {artifacts.length}
        </span>
      </footer>
    </AppShell>

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


















