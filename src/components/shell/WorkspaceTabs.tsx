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
}

export function WorkspaceTabs({ tabs, activeTabId, onSelectTab, onCloseTab, onCreateTab }: WorkspaceTabsProps) {
  return (
    <div className="workspace-tabs" role="tablist" aria-label="Workspace tabs">
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
              ×
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
  );
}

