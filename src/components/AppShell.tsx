import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Divider } from "./shell/Divider";

interface AppShellProps {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  onSidebarResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onInspectorResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onBottomPanelResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  rail: ReactNode;
  sidebar: ReactNode;
  leftHeader: ReactNode;
  workspace: ReactNode;
  topRightControls?: ReactNode;
  inspector: ReactNode;
  bottomPanel: ReactNode;
  children?: ReactNode;
}

export function AppShell(props: AppShellProps) {
  const {
    sidebarCollapsed,
    sidebarWidth,
    inspectorOpen,
    inspectorWidth,
    bottomPanelOpen,
    bottomPanelHeight,
    onSidebarResizeStart,
    onInspectorResizeStart,
    onBottomPanelResizeStart,
    rail,
    sidebar,
    leftHeader,
    workspace,
    topRightControls,
    inspector,
    bottomPanel,
    children
  } = props;

  const style = {
    "--sidebar-size": sidebarCollapsed ? "0px" : `${Math.round(sidebarWidth)}px`,
    "--sidebar-handle-size": "0px",
    "--inspector-size": inspectorOpen ? `${Math.round(inspectorWidth)}px` : "0px",
    "--inspector-handle-size": inspectorOpen ? "1px" : "0px",
    "--bottom-size": bottomPanelOpen ? `${Math.round(bottomPanelHeight)}px` : "0px",
    "--tabs-right-padding": inspectorOpen ? "8px" : "calc(var(--window-controls-width) + 8px)"
  } as CSSProperties;

  return (
    <div className="app-shell" style={style}>
      <div className="app-shell-left-header">{leftHeader}</div>

      {topRightControls ? <div className="app-shell-top-right-controls">{topRightControls}</div> : null}

      {inspectorOpen ? <div className="app-shell-inspector-header-overlay" aria-hidden="true" /> : null}

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

      {inspectorOpen && (
        <div
          className="pane-handle pane-handle-vertical pane-handle-right"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inspector"
          onMouseDown={onInspectorResizeStart}
        >
          <Divider orientation="vertical" />
        </div>
      )}

      {inspectorOpen && <aside className="app-shell-inspector">{inspector}</aside>}

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

