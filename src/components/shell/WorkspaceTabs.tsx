import type { MouseEvent, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface WorkspaceTab {
  id: string;
  title: string;
  closable: boolean;
}

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  trailingControls?: ReactNode;
}

export function WorkspaceTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCreateTab,
  trailingControls
}: WorkspaceTabsProps) {
  const startWindowDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    if (target.closest("button, a, input, textarea, select, [role='tab'], [data-no-window-drag='true']")) {
      return;
    }

    void getCurrentWindow().startDragging().catch(() => {
      // Ignore in non-Tauri contexts.
    });
  };

  return (
    <div className="workspace-tabs" data-tauri-drag-region="true" onMouseDown={startWindowDrag}>
      <div className="workspace-tabs-list" role="tablist" aria-label="Workspace tabs">
        {tabs.map((tab) => (
          <div key={tab.id} className={tab.id === activeTabId ? "workspace-tab active" : "workspace-tab"}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeTabId}
              className="workspace-tab-button"
              onClick={() => onSelectTab(tab.id)}
            >
              {tab.title}
            </button>
            {tab.closable && (
              <button
                type="button"
                className="workspace-tab-close"
                title={`Close ${tab.title}`}
                aria-label={`Close ${tab.title}`}
                onClick={() => onCloseTab(tab.id)}
              >
                x
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          className="workspace-tab-new"
          title="New tab (Ctrl/Cmd+T)"
          aria-label="New tab"
          onClick={onCreateTab}
        >
          +
        </button>
      </div>

      <div className="workspace-tabs-drag-region" data-tauri-drag-region="true" />
      {trailingControls ? <div className="workspace-tabs-trailing">{trailingControls}</div> : null}
    </div>
  );
}