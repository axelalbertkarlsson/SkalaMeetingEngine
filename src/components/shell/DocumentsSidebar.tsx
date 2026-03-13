import { useEffect, useMemo, useRef, useState } from "react";
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
  onCreateNote: (parentFolderId?: string) => void;
  onCreateFolder: (parentFolderId?: string) => void;
  onOpenInNewTab: (itemId: string) => void;
  onDuplicateItem: (itemId: string) => void;
  onCopyPath: (itemId: string) => void;
  onRenameItem: (itemId: string) => void;
  onDeleteItem: (itemId: string) => void;
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
  onCreateNote,
  onCreateFolder,
  onOpenInNewTab,
  onDuplicateItem,
  onCopyPath,
  onRenameItem,
  onDeleteItem
}: DocumentsSidebarProps) {
  const [sortAscending, setSortAscending] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(["documents-folder-pps"]));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const expandableIds = useMemo(() => collectExpandableIds(folders), [folders]);
  const visibleTree = useMemo(() => sortTree(folders, sortAscending), [folders, sortAscending]);

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

  const renderTree = (items: DocumentTreeItem[], depth = 0) => {
    return (
      <ul className="documents-tree-list" role={depth === 0 ? "tree" : "group"}>
        {items.map((item) => {
          const hasChildren = isFolder(item) && Boolean(item.children?.length);
          const isExpanded = hasChildren && expandedIds.has(item.id);
          const isActive = item.id === selectedItemId;

          return (
            <li key={item.id}>
              <button
                type="button"
                className={isActive ? "documents-tree-row active" : "documents-tree-row"}
                style={{ paddingInlineStart: `${8 + depth * 18}px` }}
                onClick={() => {
                  onSelectItem(item.id);
                  if (hasChildren) {
                    toggleExpanded(item.id);
                  }
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

              {hasChildren && isExpanded ? renderTree(item.children ?? [], depth + 1) : null}
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

