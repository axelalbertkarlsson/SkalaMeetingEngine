import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Divider } from "./shell/Divider";

interface AppShellProps {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
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
    "--sidebar-size": sidebarCollapsed ? "0px" : `${sidebarWidth}px`,
    "--sidebar-handle-size": "0px",
    "--inspector-size": inspectorOpen ? `${inspectorWidth}px` : "0px",
    "--inspector-handle-size": inspectorOpen ? "6px" : "0px",
    "--bottom-size": bottomPanelOpen ? `${bottomPanelHeight}px` : "0px"
  } as CSSProperties;

  return (
    <div className="app-shell" style={style}>
      <div className="app-shell-left-header">{leftHeader}</div>

      {topRightControls ? <div className="app-shell-top-right-controls">{topRightControls}</div> : null}

      <div className="app-shell-rail">{rail}</div>

      <aside className="app-shell-sidebar" aria-hidden={sidebarCollapsed}>
        {sidebar}
      </aside>

      <main className="app-shell-workspace">{workspace}</main>

      {inspectorOpen && (
        <div
          className="pane-handle pane-handle-vertical"
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
