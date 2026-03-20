import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ClipboardIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CollapseAllIcon,
  DuplicateIcon,
  ExpandAllIcon,
  NewFolderIcon,
  NewNoteIcon,
  OpenInNewTabIcon,
  RenameIcon,
  TrashIcon,
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
  onCreateNote: (parentFolderId?: string) => DocumentTreeItem;
  onCreateFolder: (parentFolderId?: string) => DocumentTreeItem;
  onOpenInNewTab: (itemId: string) => void;
  onDuplicateItem: (itemId: string) => void;
  onCopyPath: (itemId: string) => void;
  onRenameItem: (itemId: string) => void;
  onInlineRenameItem: (itemId: string, nextLabel: string) => void;
  onDeleteItem: (itemId: string) => void;
  onClearSelection: () => void;
  onMoveItem: (itemId: string, targetFolderId: string | null) => void;
}

const ROOT_DROP_TARGET = "__documents-root__";

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
    .sort((a, b) => {
      const folderOrder = Number(isFolder(b)) - Number(isFolder(a));
      if (folderOrder !== 0) {
        return folderOrder;
      }

      return a.label.localeCompare(b.label) * direction;
    })
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

function getContextActionIcon(actionId: DocumentContextAction) {
  switch (actionId) {
    case "open-in-new-tab":
      return <OpenInNewTabIcon />;
    case "new-note":
      return <NewNoteIcon />;
    case "new-subfolder":
      return <NewFolderIcon />;
    case "create-copy":
      return <DuplicateIcon />;
    case "copy-path":
      return <ClipboardIcon />;
    case "rename":
      return <RenameIcon />;
    case "delete":
      return <TrashIcon />;
    default:
      return null;
  }
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
  onInlineRenameItem,
  onDeleteItem,
  onClearSelection,
  onMoveItem
}: DocumentsSidebarProps) {
  const [sortAscending, setSortAscending] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(["documents-folder-pps"]));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const expandTimerRef = useRef<number | null>(null);
  const expandTimerTargetRef = useRef<string | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragJustEndedRef = useRef(false);
  const inlineEditInputRef = useRef<HTMLInputElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);

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

    const rootDropElement = elementAtPoint?.closest<HTMLElement>("[data-doc-root-drop='true']");
    if (rootDropElement) {
      return ROOT_DROP_TARGET;
    }

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

  const cancelInlineRename = () => {
    setEditingItemId(null);
    setEditingValue("");
  };

  const beginInlineRename = (item: DocumentTreeItem) => {
    setContextMenu(null);
    setEditingItemId(item.id);
    setEditingValue(item.label);
  };

  const beginInlineRenameForCreatedItem = (item: DocumentTreeItem) => {
    onSelectItem(item.id);
    beginInlineRename(item);
  };

  const commitInlineRename = (item: DocumentTreeItem) => {
    const nextLabel = editingValue.trim();
    if (nextLabel && nextLabel !== item.label) {
      onInlineRenameItem(item.id, nextLabel);
    }

    cancelInlineRename();
  };

  useEffect(() => {
    if (!editingItemId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const input = inlineEditInputRef.current;
      if (!input) {
        return;
      }

      input.focus();
      input.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [editingItemId]);

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
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
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
      beginInlineRenameForCreatedItem(onCreateNote(targetId));
    } else if (actionId === "new-subfolder") {
      beginInlineRenameForCreatedItem(onCreateFolder(targetId));
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
          const isExpanded = isFolderItem && expandedIds.has(item.id);
          const isActive = item.id === selectedItemId;
          const isEditing = editingItemId === item.id;
          const rowDropFolderId = isFolderItem ? item.id : parentFolderId;
          const isDropTarget = rowDropFolderId !== null && dropTargetFolderId === rowDropFolderId;
          const isDragging = draggingItemId === item.id;

          const rowClassName = [
            "documents-tree-row",
            isActive ? "active" : "",
            isDropTarget ? "drop-target" : "",
            isDragging ? "dragging" : "",
            isEditing ? "editing" : ""
          ]
            .filter(Boolean)
            .join(" ");

          const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
            if (event.button !== 0 || editingItemId) {
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

              if (nextFolderId && nextFolderId !== ROOT_DROP_TARGET) {
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
                  onMoveItem(
                    sourceItemId,
                    hoveredFolderId === ROOT_DROP_TARGET ? null : hoveredFolderId
                  );
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

                  if (isEditing) {
                    return;
                  }

                  if (clickTimerRef.current !== null) {
                    window.clearTimeout(clickTimerRef.current);
                  }

                  clickTimerRef.current = window.setTimeout(() => {
                    clickTimerRef.current = null;

                    onSelectItem(item.id);
                    if (isFolderItem) {
                      toggleExpanded(item.id);
                      return;
                    }

                    onOpenNote(item.id);
                  }, 180);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();

                  if (clickTimerRef.current !== null) {
                    window.clearTimeout(clickTimerRef.current);
                    clickTimerRef.current = null;
                  }

                  beginInlineRename(item);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (isEditing) {
                    return;
                  }

                  onSelectItem(item.id);
                  setContextMenu({
                    itemId: item.id,
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
              >
                <span className="documents-tree-caret" aria-hidden="true">
                  {isFolderItem ? isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon /> : null}
                </span>

                {isEditing ? (
                  <input
                    ref={inlineEditInputRef}
                    className="documents-tree-inline-input"
                    value={editingValue}
                    onChange={(event) => setEditingValue(event.target.value)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={() => commitInlineRename(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitInlineRename(item);
                        return;
                      }

                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelInlineRename();
                      }
                    }}
                  />
                ) : (
                  <span className="documents-tree-label">{item.label}</span>
                )}
              </button>

              {isFolderItem && isExpanded ? renderTree(item.children ?? [], depth + 1, item.id) : null}
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
              onClick={() => beginInlineRenameForCreatedItem(onCreateNote())}
            >
              <NewNoteIcon />
            </button>
            <button
              type="button"
              className="documents-sidebar-action"
              title="New folder"
              aria-label="New folder"
              onClick={() => beginInlineRenameForCreatedItem(onCreateFolder())}
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

          <div
            className="documents-sidebar-content"
            onMouseDown={(event) => {
              if (event.target !== event.currentTarget) {
                return;
              }

              onClearSelection();
              setContextMenu(null);
              if (editingItemId) {
                cancelInlineRename();
              }
            }}
          >
            {renderTree(visibleTree)}
            <div
              className={[
                "documents-tree-root-drop-zone",
                draggingItemId ? "drag-active" : "",
                dropTargetFolderId === ROOT_DROP_TARGET ? "drop-target" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              data-doc-root-drop="true"
              aria-hidden="true"
            />
          </div>

          {contextMenu && contextItem ? (
            <div
              ref={contextMenuRef}
              className="documents-context-menu documents-tree-context-menu"
              style={{
                left: `${Math.min(contextMenu.x, window.innerWidth - 192)}px`,
                top: `${Math.min(contextMenu.y, window.innerHeight - 240)}px`
              }}
              role="menu"
              aria-label={`Actions for ${contextItem.label}`}
            >
              {contextActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={action.danger ? "documents-context-menu-item documents-tree-context-menu-item danger" : "documents-context-menu-item documents-tree-context-menu-item"}
                  role="menuitem"
                  onClick={() => runContextAction(action.id)}
                >
                  <span className="documents-tree-context-menu-icon" aria-hidden="true">
                    {getContextActionIcon(action.id)}
                  </span>
                  <span className="documents-tree-context-menu-label">{action.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}












