import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  NewFolderIcon,
  NewNoteIcon,
  SortIcon
} from "./icons";

export type DocumentTreeItemKind = "folder" | "note";

export interface DocumentTreeItem {
  id: string;
  label: string;
  kind?: DocumentTreeItemKind;
  children?: DocumentTreeItem[];
}

type DocumentContextAction =
  | "open-in-new-tab"
  | "new-note"
  | "new-subfolder"
  | "create-copy"
  | "copy-path"
  | "rename"
  | "delete";

interface DocumentsSidebarProps {
  collapsed: boolean;
  folders: DocumentTreeItem[];
  selectedItemId?: string;
  onSelectItem: (itemId: string) => void;
  onOpenNote: (itemId: string) => void;
  onCreateNote: (parentFolderId?: string) => void;
  onCreateFolder: (parentFolderId?: string) => void;
  onOpenInNewTab: (itemId: string) => void;
  onDuplicateItem: (itemId: string) => void;
  onCopyPath: (itemId: string) => void;
  onRenameItem: (itemId: string) => void;
  onDeleteItem: (itemId: string) => void;
  onMoveItem: (itemId: string, targetFolderId: string) => void;
}

interface ContextMenuState {
  itemId: string;
  x: number;
  y: number;
}

function isFolder(item: DocumentTreeItem) {
  return item.kind !== "note";
}

function collectExpandableIds(items: DocumentTreeItem[]): string[] {
  return items.flatMap((item) => {
    if (!isFolder(item) || !item.children || item.children.length === 0) {
      return [];
    }

    return [item.id, ...collectExpandableIds(item.children)];
  });
}

function sortTree(items: DocumentTreeItem[], asc: boolean): DocumentTreeItem[] {
  const direction = asc ? 1 : -1;
  return [...items]
    .sort((a, b) => a.label.localeCompare(b.label) * direction)
    .map((item) => ({
      ...item,
      children: item.children ? sortTree(item.children, asc) : undefined
    }));
}

function findFolderPathToItem(items: DocumentTreeItem[], itemId: string, parents: string[] = []): string[] | null {
  for (const item of items) {
    const nextParents = isFolder(item) ? [...parents, item.id] : parents;

    if (item.id === itemId) {
      return nextParents;
    }

    if (item.children?.length) {
      const found = findFolderPathToItem(item.children, itemId, nextParents);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function findItemById(items: DocumentTreeItem[], itemId: string): DocumentTreeItem | undefined {
  for (const item of items) {
    if (item.id === itemId) {
      return item;
    }

    if (item.children?.length) {
      const found = findItemById(item.children, itemId);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

function getContextActions(item: DocumentTreeItem): Array<{ id: DocumentContextAction; label: string; danger?: boolean }> {
  if (isFolder(item)) {
    return [
      { id: "new-note", label: "New note" },
      { id: "new-subfolder", label: "New subfolder" },
      { id: "create-copy", label: "Create copy" },
      { id: "copy-path", label: "Copy path" },
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", danger: true }
    ];
  }

  return [
    { id: "open-in-new-tab", label: "Open in new tab" },
    { id: "create-copy", label: "Create copy" },
    { id: "copy-path", label: "Copy path" },
    { id: "rename", label: "Rename" },
    { id: "delete", label: "Delete", danger: true }
  ];
}

export function DocumentsSidebar({
  collapsed,
  folders,
  selectedItemId,
  onSelectItem,
  onOpenNote,
  onCreateNote,
  onCreateFolder,
  onOpenInNewTab,
  onDuplicateItem,
  onCopyPath,
  onRenameItem,
  onDeleteItem,
  onMoveItem
}: DocumentsSidebarProps) {
  const [sortAscending, setSortAscending] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(["documents-folder-pps"]));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null);

  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const expandTimerRef = useRef<number | null>(null);
  const expandTimerTargetRef = useRef<string | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragJustEndedRef = useRef(false);

  const expandableIds = useMemo(() => collectExpandableIds(folders), [folders]);
  const visibleTree = useMemo(() => sortTree(folders, sortAscending), [folders, sortAscending]);

  const clearExpandTimer = () => {
    if (expandTimerRef.current !== null) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }

    expandTimerTargetRef.current = null;
  };

  const queueExpandFolder = (folderId: string) => {
    if (expandedIds.has(folderId)) {
      return;
    }

    if (expandTimerTargetRef.current === folderId) {
      return;
    }

    clearExpandTimer();
    expandTimerTargetRef.current = folderId;
    expandTimerRef.current = window.setTimeout(() => {
      setExpandedIds((current) => {
        if (current.has(folderId)) {
          return current;
        }

        const next = new Set(current);
        next.add(folderId);
        return next;
      });

      expandTimerRef.current = null;
      expandTimerTargetRef.current = null;
    }, 220);
  };

  const clearDragState = () => {
    setDraggingItemId(null);
    setDropTargetFolderId(null);
    clearExpandTimer();
  };

  const resolveFolderDropTargetAtPoint = (clientX: number, clientY: number, sourceItemId: string) => {
    const elementAtPoint = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const rowElement = elementAtPoint?.closest<HTMLButtonElement>("[data-doc-tree-row='true']");

    if (!rowElement) {
      return null;
    }

    const targetFolderId = rowElement.dataset.docFolderId;
    if (!targetFolderId || targetFolderId === sourceItemId) {
      return null;
    }

    return targetFolderId;
  };

  useEffect(() => {
    if (!selectedItemId) {
      return;
    }

    const path = findFolderPathToItem(visibleTree, selectedItemId);
    if (!path?.length) {
      return;
    }

    setExpandedIds((current) => {
      const next = new Set(current);
      path.forEach((id) => next.add(id));
      return next;
    });
  }, [selectedItemId, visibleTree]);

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
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      clearExpandTimer();
    };
  }, []);

  const toggleExpanded = (itemId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const runContextAction = (actionId: DocumentContextAction) => {
    if (!contextMenu) {
      return;
    }

    const targetId = contextMenu.itemId;
    const targetItem = findItemById(visibleTree, targetId);

    if (!targetItem) {
      setContextMenu(null);
      return;
    }

    if (actionId === "open-in-new-tab") {
      onOpenInNewTab(targetId);
    } else if (actionId === "new-note") {
      onCreateNote(targetId);
    } else if (actionId === "new-subfolder") {
      onCreateFolder(targetId);
    } else if (actionId === "create-copy") {
      onDuplicateItem(targetId);
    } else if (actionId === "copy-path") {
      onCopyPath(targetId);
    } else if (actionId === "rename") {
      onRenameItem(targetId);
    } else if (actionId === "delete") {
      onDeleteItem(targetId);
    }

    setContextMenu(null);
  };

  const renderTree = (items: DocumentTreeItem[], depth = 0, parentFolderId: string | null = null) => {
    return (
      <ul className="documents-tree-list" role={depth === 0 ? "tree" : "group"}>
        {items.map((item) => {
          const isFolderItem = isFolder(item);
          const hasChildren = isFolderItem && Boolean(item.children?.length);
          const isExpanded = hasChildren && expandedIds.has(item.id);
          const isActive = item.id === selectedItemId;
          const rowDropFolderId = isFolderItem ? item.id : parentFolderId;
          const isDropTarget = rowDropFolderId !== null && dropTargetFolderId === rowDropFolderId;
          const isDragging = draggingItemId === item.id;

          const rowClassName = [
            "documents-tree-row",
            isActive ? "active" : "",
            isDropTarget ? "drop-target" : "",
            isDragging ? "dragging" : ""
          ]
            .filter(Boolean)
            .join(" ");

          const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
            if (event.button !== 0) {
              return;
            }

            const sourceItemId = item.id;
            const pointerId = event.pointerId;
            const startX = event.clientX;
            const startY = event.clientY;
            let hasStartedDragging = false;
            let hoveredFolderId: string | null = null;

            dragCleanupRef.current?.();
            dragCleanupRef.current = null;

            const finishDrag = () => {
              window.removeEventListener("pointermove", onWindowPointerMove);
              window.removeEventListener("pointerup", onWindowPointerUp);
              window.removeEventListener("pointercancel", onWindowPointerUp);
              dragCleanupRef.current = null;
              clearDragState();
            };

            const onWindowPointerMove = (moveEvent: PointerEvent) => {
              if (moveEvent.pointerId !== pointerId) {
                return;
              }

              const distance = Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY);
              if (!hasStartedDragging && distance < 5) {
                return;
              }

              if (!hasStartedDragging) {
                hasStartedDragging = true;
                setDraggingItemId(sourceItemId);
                setDropTargetFolderId(null);
              }

              moveEvent.preventDefault();

              const nextFolderId = resolveFolderDropTargetAtPoint(
                moveEvent.clientX,
                moveEvent.clientY,
                sourceItemId
              );

              hoveredFolderId = nextFolderId;
              setDropTargetFolderId(nextFolderId);

              if (nextFolderId) {
                queueExpandFolder(nextFolderId);
              } else {
                clearExpandTimer();
              }
            };

            const onWindowPointerUp = (upEvent: PointerEvent) => {
              if (upEvent.pointerId !== pointerId) {
                return;
              }

              if (hasStartedDragging) {
                dragJustEndedRef.current = true;

                if (hoveredFolderId && hoveredFolderId !== sourceItemId) {
                  onMoveItem(sourceItemId, hoveredFolderId);
                }
              }

              finishDrag();
            };

            window.addEventListener("pointermove", onWindowPointerMove, { passive: false });
            window.addEventListener("pointerup", onWindowPointerUp);
            window.addEventListener("pointercancel", onWindowPointerUp);
            dragCleanupRef.current = finishDrag;
          };

          return (
            <li key={item.id}>
              <button
                type="button"
                className={rowClassName}
                style={{ paddingInlineStart: `${8 + depth * 18}px` }}
                data-doc-tree-row="true"
                data-doc-item-id={item.id}
                data-doc-folder-id={rowDropFolderId ?? undefined}
                onPointerDown={onPointerDown}
                onClick={() => {
                  if (dragJustEndedRef.current) {
                    dragJustEndedRef.current = false;
                    return;
                  }

                  onSelectItem(item.id);
                  if (isFolderItem) {
                    toggleExpanded(item.id);
                    return;
                  }

                  onOpenNote(item.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onSelectItem(item.id);
                  setContextMenu({
                    itemId: item.id,
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
              >
                <span className="documents-tree-caret" aria-hidden="true">
                  {hasChildren ? isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon /> : null}
                </span>
                <span className="documents-tree-label">{item.label}</span>
              </button>

              {hasChildren && isExpanded ? renderTree(item.children ?? [], depth + 1, item.id) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  const contextItem = contextMenu ? findItemById(visibleTree, contextMenu.itemId) : undefined;
  const contextActions = contextItem ? getContextActions(contextItem) : [];

  return (
    <div className="documents-sidebar">
      {!collapsed && (
        <>
          <div className="documents-sidebar-toolbar" role="toolbar" aria-label="Documents folder actions">
            <button
              type="button"
              className="documents-sidebar-action"
              title="New note"
              aria-label="New note"
              onClick={() => onCreateNote()}
            >
              <NewNoteIcon />
            </button>
            <button
              type="button"
              className="documents-sidebar-action"
              title="New folder"
              aria-label="New folder"
              onClick={() => onCreateFolder()}
            >
              <NewFolderIcon />
            </button>
            <button
              type="button"
              className="documents-sidebar-action"
              title={sortAscending ? "Change sort (A-Z)" : "Change sort (Z-A)"}
              aria-label="Change sort"
              onClick={() => setSortAscending((current) => !current)}
            >
              <SortIcon />
            </button>
            <button
              type="button"
              className="documents-sidebar-action"
              title="Expand all"
              aria-label="Expand all"
              onClick={() => setExpandedIds(new Set(expandableIds))}
            >
              <ExpandAllIcon />
            </button>
            <button
              type="button"
              className="documents-sidebar-action"
              title="Collapse all"
              aria-label="Collapse all"
              onClick={() => setExpandedIds(new Set())}
            >
              <CollapseAllIcon />
            </button>
          </div>

          <div className="documents-sidebar-content">{renderTree(visibleTree)}</div>

          {contextMenu && contextItem ? (
            <div
              ref={contextMenuRef}
              className="documents-context-menu"
              style={{
                left: `${Math.min(contextMenu.x, window.innerWidth - 220)}px`,
                top: `${Math.min(contextMenu.y, window.innerHeight - 240)}px`
              }}
              role="menu"
              aria-label={`Actions for ${contextItem.label}`}
            >
              {contextActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={action.danger ? "documents-context-menu-item danger" : "documents-context-menu-item"}
                  role="menuitem"
                  onClick={() => runContextAction(action.id)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}


