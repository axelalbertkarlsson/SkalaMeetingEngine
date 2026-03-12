import type { MouseEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface WorkspaceTab {
  id: string;
  title: string;
  closable: boolean;
}

type DropPlacement = "before" | "after";

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  onReorderTabs: (draggedTabId: string, targetTabId: string, placement: DropPlacement) => void;
  trailingControls?: ReactNode;
}

interface PointerDragState {
  tabId: string;
  startX: number;
  startY: number;
  active: boolean;
}

export function WorkspaceTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCreateTab,
  onReorderTabs,
  trailingControls
}: WorkspaceTabsProps) {
  const [pointerDrag, setPointerDrag] = useState<PointerDragState | null>(null);
  const [dropTarget, setDropTarget] = useState<{ tabId: string; placement: DropPlacement } | null>(null);

  const startWindowDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    if (
      target.closest(
        "button, a, input, textarea, select, [role='tab'], [data-no-window-drag='true']"
      )
    ) {
      return;
    }

    void getCurrentWindow().startDragging().catch(() => {
      // Ignore in non-Tauri contexts.
    });
  };

  const beginTabDrag = (tabId: string, event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-no-tab-drag='true']")) {
      return;
    }

    setPointerDrag({
      tabId,
      startX: event.clientX,
      startY: event.clientY,
      active: false
    });
    setDropTarget(null);
  };

  useEffect(() => {
    if (!pointerDrag) {
      return;
    }

    const threshold = 4;

    const updateDropTargetFromPointer = (event: globalThis.MouseEvent, sourceTabId: string) => {
      const hovered = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const targetTab = hovered?.closest<HTMLElement>(".workspace-tab[data-tab-id]");
      const targetTabId = targetTab?.dataset.tabId;

      if (!targetTab || !targetTabId || targetTabId === sourceTabId) {
        setDropTarget(null);
        return;
      }

      const bounds = targetTab.getBoundingClientRect();
      const midpoint = bounds.left + bounds.width / 2;
      const placement: DropPlacement = event.clientX < midpoint ? "before" : "after";

      setDropTarget((current) => {
        if (current?.tabId === targetTabId && current.placement === placement) {
          return current;
        }

        return { tabId: targetTabId, placement };
      });
    };

    const onMouseMove = (event: globalThis.MouseEvent) => {
      if (!pointerDrag.active) {
        const deltaX = event.clientX - pointerDrag.startX;
        const deltaY = event.clientY - pointerDrag.startY;
        if (Math.hypot(deltaX, deltaY) < threshold) {
          return;
        }

        setPointerDrag((current) => (current ? { ...current, active: true } : current));
        updateDropTargetFromPointer(event, pointerDrag.tabId);
        return;
      }

      updateDropTargetFromPointer(event, pointerDrag.tabId);
    };

    const onMouseUp = () => {
      if (pointerDrag.active && dropTarget) {
        onReorderTabs(pointerDrag.tabId, dropTarget.tabId, dropTarget.placement);
      }

      setPointerDrag(null);
      setDropTarget(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    if (pointerDrag.active) {
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [pointerDrag, dropTarget, onReorderTabs]);

  return (
    <div className="workspace-tabs" onMouseDown={startWindowDrag}>
      <div className="workspace-tabs-main">
        <div className="workspace-tabs-list" role="tablist" aria-label="Workspace tabs">
          {tabs.map((tab) => {
            const isDropTarget = dropTarget?.tabId === tab.id;
            const isDragging = pointerDrag?.active && pointerDrag.tabId === tab.id;
            const className = [
              "workspace-tab",
              tab.id === activeTabId ? "active" : "",
              isDragging ? "dragging" : "",
              isDropTarget && dropTarget?.placement === "before" ? "drop-before" : "",
              isDropTarget && dropTarget?.placement === "after" ? "drop-after" : ""
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <div
                key={tab.id}
                className={className}
                data-tab-id={tab.id}
                data-no-window-drag="true"
                onMouseDown={(event) => beginTabDrag(tab.id, event)}
              >
                <span className="workspace-tab-hover-surface" aria-hidden="true" />
                <div className="workspace-tab-inner">
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
                      data-no-tab-drag="true"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => onCloseTab(tab.id)}
                    >
                      x
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

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

      {trailingControls ? <div className="workspace-tabs-trailing">{trailingControls}</div> : null}
    </div>
  );
}
