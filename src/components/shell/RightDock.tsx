import type { ReactNode } from "react";

export type RightDockTabId = "codex" | "info";

interface RightDockProps {
  activeTabId: RightDockTabId;
  codexContent: ReactNode;
  infoContent: ReactNode;
}

export function RightDock({
  activeTabId,
  codexContent,
  infoContent
}: RightDockProps) {
  return (
    <div className="right-dock">
      <div className="right-dock-content">
        {activeTabId === "codex" ? codexContent : infoContent}
      </div>
    </div>
  );
}
