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
      <div className={activeTabId === "codex" ? "right-dock-content right-dock-content-codex" : "right-dock-content"}>
        {activeTabId === "codex" ? codexContent : infoContent}
      </div>
    </div>
  );
}
