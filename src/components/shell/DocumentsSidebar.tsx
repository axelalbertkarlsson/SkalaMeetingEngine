import { useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  NewFolderIcon,
  NewNoteIcon,
  SortIcon
} from "./icons";

export interface DocumentTreeItem {
  id: string;
  label: string;
  children?: DocumentTreeItem[];
}

interface DocumentsSidebarProps {
  collapsed: boolean;
  folders: DocumentTreeItem[];
  selectedItemId?: string;
  onSelectItem: (itemId: string) => void;
}

function collectExpandableIds(items: DocumentTreeItem[]): string[] {
  return items.flatMap((item) => {
    if (!item.children || item.children.length === 0) {
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

export function DocumentsSidebar({
  collapsed,
  folders,
  selectedItemId,
  onSelectItem
}: DocumentsSidebarProps) {
  const [sortAscending, setSortAscending] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(["documents-folder-pps"]));

  const expandableIds = useMemo(() => collectExpandableIds(folders), [folders]);
  const visibleTree = useMemo(() => sortTree(folders, sortAscending), [folders, sortAscending]);

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

  const renderTree = (items: DocumentTreeItem[], depth = 0) => {
    return (
      <ul className="documents-tree-list" role={depth === 0 ? "tree" : "group"}>
        {items.map((item) => {
          const hasChildren = Boolean(item.children?.length);
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

  return (
    <div className="documents-sidebar">
      {!collapsed && (
        <>
          <div className="documents-sidebar-toolbar" role="toolbar" aria-label="Documents folder actions">
            <button type="button" className="documents-sidebar-action" title="New note" aria-label="New note">
              <NewNoteIcon />
            </button>
            <button
              type="button"
              className="documents-sidebar-action"
              title="New folder"
              aria-label="New folder"
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
        </>
      )}
    </div>
  );
}
