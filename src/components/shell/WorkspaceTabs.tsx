import type { MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DuplicateIcon, PinIcon, WindowCloseIcon } from "./icons";

export interface WorkspaceTab {
  id: string;
  title: string;
  closable: boolean;
  pinned: boolean;
}

type DropPlacement = "before" | "after";
type TabContextAction = "close" | "toggle-pin" | "duplicate";

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onToggleTabPin: (tabId: string) => void;
  onDuplicateTab: (tabId: string) => void;
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

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

export function WorkspaceTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onToggleTabPin,
  onDuplicateTab,
  onCreateTab,
  onReorderTabs,
  trailingControls
}: WorkspaceTabsProps) {
  const [pointerDrag, setPointerDrag] = useState<PointerDragState | null>(null);
  const [dropTarget, setDropTarget] = useState<{ tabId: string; placement: DropPlacement } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && contextMenuRef.current?.contains(target)) {
        return;
      }

      setContextMenu(null);
    };

    const closeMenu = () => setContextMenu(null);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    if (!tabs.some((tab) => tab.id === contextMenu.tabId)) {
      setContextMenu(null);
    }
  }, [contextMenu, tabs]);

  const runContextAction = (actionId: TabContextAction) => {
    if (!contextMenu) {
      return;
    }

    const targetTabId = contextMenu.tabId;

    if (actionId === "close") {
      onCloseTab(targetTabId);
    } else if (actionId === "toggle-pin") {
      onToggleTabPin(targetTabId);
    } else if (actionId === "duplicate") {
      onDuplicateTab(targetTabId);
    }

    setContextMenu(null);
  };

  const contextTab = contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) : undefined;

  return (
    <div className="workspace-tabs" onMouseDown={startWindowDrag}>
      <div className="workspace-tabs-main">
        <div className="workspace-tabs-list" role="tablist" aria-label="Workspace tabs">
          {tabs.map((tab, index) => {
            const nextTab = tabs[index + 1];
            const hasSeparatorAfter =
              tab.id !== activeTabId && nextTab !== undefined && nextTab.id !== activeTabId;
            const isDropTarget = dropTarget?.tabId === tab.id;
            const isDragging = pointerDrag?.active && pointerDrag.tabId === tab.id;
            const className = [
              "workspace-tab",
              tab.id === activeTabId ? "active" : "",
              hasSeparatorAfter ? "has-separator-after" : "",
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
                onContextMenu={(event) => {
                  event.preventDefault();
                  onSelectTab(tab.id);
                  setContextMenu({
                    tabId: tab.id,
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
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
                      className={tab.pinned ? "workspace-tab-close pinned" : "workspace-tab-close"}
                      title={tab.pinned ? `Un-pin ${tab.title}` : `Close ${tab.title}`}
                      aria-label={tab.pinned ? `Un-pin ${tab.title}` : `Close ${tab.title}`}
                      data-no-tab-drag="true"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        if (tab.pinned) {
                          onToggleTabPin(tab.id);
                          return;
                        }

                        onCloseTab(tab.id);
                      }}
                    >
                      {tab.pinned ? <PinIcon /> : <WindowCloseIcon />}
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

      {contextMenu && contextTab ? (
        <div
          ref={contextMenuRef}
          className="documents-context-menu documents-tree-context-menu workspace-tab-context-menu"
          style={{
            left: `${Math.min(contextMenu.x, window.innerWidth - 196)}px`,
            top: `${Math.min(contextMenu.y, window.innerHeight - 156)}px`
          }}
          role="menu"
          aria-label={`Actions for ${contextTab.title}`}
        >
          <button
            type="button"
            className="documents-context-menu-item documents-tree-context-menu-item"
            role="menuitem"
            onClick={() => runContextAction("close")}
          >
            <span className="documents-tree-context-menu-icon" aria-hidden="true">
              <WindowCloseIcon />
            </span>
            <span className="documents-tree-context-menu-label">Close tab</span>
          </button>
          <button
            type="button"
            className="documents-context-menu-item documents-tree-context-menu-item"
            role="menuitem"
            onClick={() => runContextAction("toggle-pin")}
          >
            <span className="documents-tree-context-menu-icon" aria-hidden="true">
              <PinIcon />
            </span>
            <span className="documents-tree-context-menu-label">
              {contextTab.pinned ? "Un-pin tab" : "Pin tab"}
            </span>
          </button>
          <button
            type="button"
            className="documents-context-menu-item documents-tree-context-menu-item"
            role="menuitem"
            onClick={() => runContextAction("duplicate")}
          >
            <span className="documents-tree-context-menu-icon" aria-hidden="true">
              <DuplicateIcon />
            </span>
            <span className="documents-tree-context-menu-label">Duplicate tab</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
