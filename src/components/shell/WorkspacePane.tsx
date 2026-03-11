import type { ReactNode } from "react";
import { WorkspaceTabs, type WorkspaceTab } from "./WorkspaceTabs";

interface WorkspacePaneProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  children: ReactNode;
}

export function WorkspacePane(props: WorkspacePaneProps) {
  const { tabs, activeTabId, onSelectTab, onCloseTab, onCreateTab, children } = props;

  return (
    <section className="workspace-pane">
      <WorkspaceTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onCreateTab={onCreateTab}
      />
      <div className="workspace-pane-content">{children}</div>
    </section>
  );
}

