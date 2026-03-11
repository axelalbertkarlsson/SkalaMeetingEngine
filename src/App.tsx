import { useEffect, useMemo, useState } from "react";
import { AppShell } from "./components/AppShell";
import { BottomPanel, type BottomPanelView } from "./components/shell/BottomPanel";
import {
  CollapsibleSidebar,
  type SidebarGroupData
} from "./components/shell/CollapsibleSidebar";
import { InspectorPane, type InspectorSection } from "./components/shell/InspectorPane";
import { RibbonRail, type RibbonSection, type RibbonUtilityAction } from "./components/shell/RibbonRail";
import { WorkspacePane } from "./components/shell/WorkspacePane";
import { WindowTitleBar } from "./components/shell/WindowTitleBar";
import {
  CodeIcon,
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
import { RunsScreen } from "./screens/RunsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { VaultScreen } from "./screens/VaultScreen";

type SectionId = "home" | "meetings" | "runs" | "vault" | "codex" | "settings";
type ThemeMode = "dark" | "light";

interface WorkspaceTabState {
  id: string;
  title: string;
  kind: "section" | "scratch";
  sectionId?: SectionId;
  closable: boolean;
}

const sectionTitles: Record<SectionId, string> = {
  home: "Home",
  meetings: "Meetings",
  runs: "Runs",
  vault: "Vault",
  codex: "Codex",
  settings: "Settings"
};

const railSections: RibbonSection[] = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "meetings", label: "Meetings", icon: <MeetingIcon /> },
  { id: "runs", label: "Runs", icon: <RunIcon /> },
  { id: "vault", label: "Vault", icon: <VaultIcon /> },
  { id: "codex", label: "Codex", icon: <CodeIcon /> },
  { id: "settings", label: "Settings", icon: <GearIcon /> }
];

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
      runs: "runs-running",
      vault: "vault-info",
      codex: "codex-workspace",
      settings: "settings-general"
    }
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
              `${statusLabels[run.status]} · ${new Date(run.startedAt).toLocaleDateString()}`,
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
              `${statusLabels[run.status]} · ${run.type.replace("_", " ")}`,
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
              `${statusLabels[run.status]} · ${new Date(run.startedAt).toLocaleDateString()}`,
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
              `Ready for review · ${new Date(run.startedAt).toLocaleDateString()}`,
              "warning"
            )
          )
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
              `${statusLabels[run.status]} · ${new Date(run.startedAt).toLocaleDateString()}`,
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

  const activeSidebarGroups = sidebarGroupsBySection[activeSection];
  const selectedSidebarItemId =
    selectedSidebarItems[activeSection] ?? activeSidebarGroups[0]?.items[0]?.id ?? "";

  const activeTab =
    tabs.find((tab) => tab.id === activeTabId) ??
    tabs[0] ??
    createSectionTab(activeSection);
  const contentSection =
    activeTab.kind === "section" ? activeTab.sectionId ?? activeSection : activeSection;

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
            { label: "Last command", value: "codex --workspace ." },
            { label: "Output mode", value: "Bottom panel terminal stream" }
          ]
        },
        {
          id: "codex-next",
          title: "Next steps",
          rows: [
            { label: "Process bridge", value: "UI scaffold ready", tone: "neutral" },
            { label: "Streaming", value: "Pending native wiring", tone: "warning" }
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
  }, [contentSection, runStats, selectedSidebarItemId, sortedRuns, theme, workspace]);

  const bottomPanelViews = useMemo<BottomPanelView[]>(() => {
    return [
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
          "Starting session scaffold...",
          "Terminal stream will connect to native process bridge in a later task."
        ]
      }
    ];
  }, [bottomPanelHeight, bottomPanelOpen, contentSection, inspectorOpen, inspectorWidth, sidebarCollapsed, sidebarWidth]);

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

  const beginInspectorResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!inspectorOpen) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    document.body.style.cursor = "col-resize";

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = clamp(startWidth - (moveEvent.clientX - startX), 260, 340);
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
      const nextHeight = clamp(startHeight + (startY - moveEvent.clientY), 140, 320);
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

    if (sectionId === "runs") {
      return <RunsScreen runs={sortedRuns} />;
    }

    if (sectionId === "vault") {
      return <VaultScreen workspace={workspace} runs={sortedRuns} />;
    }

    if (sectionId === "codex") {
      return <CodexScreen workspace={workspace} />;
    }

    return <SettingsScreen workspace={workspace} selectedCategory={settingsCategory} />;
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
    <AppShell
      sidebarCollapsed={sidebarCollapsed}
      sidebarWidth={sidebarWidth}
      inspectorOpen={inspectorOpen}
      inspectorWidth={inspectorWidth}
      bottomPanelOpen={bottomPanelOpen}
      bottomPanelHeight={bottomPanelHeight}
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
          Workspace: {workspace.name} · Local artifacts: {artifacts.length}
        </span>
      </footer>
    </AppShell>
  );
}

export default App;




