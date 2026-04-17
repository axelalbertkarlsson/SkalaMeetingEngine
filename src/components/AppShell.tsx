import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Divider } from "./shell/Divider";

interface AppShellProps {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  rightDockOpen: boolean;
  rightDockWidth: number;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  onSidebarResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onRightDockResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onBottomPanelResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  rail: ReactNode;
  sidebar: ReactNode;
  leftHeader: ReactNode;
  workspace: ReactNode;
  topRightControls?: ReactNode;
  rightDock: ReactNode;
  bottomPanel: ReactNode;
  children?: ReactNode;
}

export function AppShell(props: AppShellProps) {
  const {
    sidebarCollapsed,
    sidebarWidth,
    rightDockOpen,
    rightDockWidth,
    bottomPanelOpen,
    bottomPanelHeight,
    onSidebarResizeStart,
    onRightDockResizeStart,
    onBottomPanelResizeStart,
    rail,
    sidebar,
    leftHeader,
    workspace,
    topRightControls,
    rightDock,
    bottomPanel,
    children
  } = props;

  const style = {
    "--sidebar-size": sidebarCollapsed ? "0px" : `${Math.round(sidebarWidth)}px`,
    "--sidebar-handle-size": "0px",
    "--inspector-size": rightDockOpen ? `${Math.round(rightDockWidth)}px` : "0px",
    "--inspector-handle-size": rightDockOpen ? "1px" : "0px",
    "--shell-columns-transition": rightDockOpen ? "none" : "grid-template-columns 180ms ease",
    "--bottom-size": bottomPanelOpen ? `${Math.round(bottomPanelHeight)}px` : "0px",
    "--tabs-right-padding": rightDockOpen ? "8px" : "calc(var(--window-controls-width) + 8px)"
  } as CSSProperties;

  return (
    <div className="app-shell" style={style}>
      <div className="app-shell-left-header">{leftHeader}</div>

      {topRightControls ? <div className="app-shell-top-right-controls">{topRightControls}</div> : null}

      {rightDockOpen ? <div className="app-shell-inspector-header-overlay" aria-hidden="true" /> : null}

      <div className="app-shell-rail">{rail}</div>

      <aside className="app-shell-sidebar" aria-hidden={sidebarCollapsed}>
        {sidebar}
      </aside>

      {!sidebarCollapsed && (
        <div
          className="pane-handle pane-handle-vertical pane-handle-left"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={onSidebarResizeStart}
        >
          <Divider orientation="vertical" />
        </div>
      )}

      <main className="app-shell-workspace">{workspace}</main>

      {rightDockOpen && (
        <div
          className="pane-handle pane-handle-vertical pane-handle-right"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize right dock"
          onMouseDown={onRightDockResizeStart}
        >
          <Divider orientation="vertical" />
        </div>
      )}

      {rightDockOpen && <aside className="app-shell-inspector">{rightDock}</aside>}

      {bottomPanelOpen && (
        <>
          <div
            className="pane-handle pane-handle-horizontal"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize bottom panel"
            onMouseDown={onBottomPanelResizeStart}
          >
            <Divider orientation="horizontal" />
          </div>
          <section className="app-shell-bottom">{bottomPanel}</section>
        </>
      )}

      <div className="app-shell-status">{children}</div>
    </div>
  );
}

