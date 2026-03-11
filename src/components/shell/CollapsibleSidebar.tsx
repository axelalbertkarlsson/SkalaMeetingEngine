import { SidebarList, type SidebarItemData } from "./SidebarList";
import { SidebarSection } from "./SidebarSection";

export interface SidebarGroupData {
  id: string;
  title: string;
  items: SidebarItemData[];
}

interface CollapsibleSidebarProps {
  title: string;
  collapsed: boolean;
  groups: SidebarGroupData[];
  selectedItemId?: string;
  onSelectItem: (itemId: string) => void;
  onToggleCollapse: () => void;
}

export function CollapsibleSidebar(props: CollapsibleSidebarProps) {
  const { title, collapsed, groups, selectedItemId, onSelectItem, onToggleCollapse } = props;

  return (
    <div className="collapsible-sidebar">
      {!collapsed && (
        <>
          <header className="sidebar-header">
            <p className="sidebar-title">{title}</p>
            <button
              type="button"
              className="icon-inline-button"
              onClick={onToggleCollapse}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              ×
            </button>
          </header>

          <div className="sidebar-content">
            {groups.length === 0 ? (
              <p className="sidebar-empty">No items yet.</p>
            ) : (
              groups.map((group) => (
                <SidebarSection key={group.id} title={group.title}>
                  <SidebarList
                    items={group.items}
                    selectedItemId={selectedItemId}
                    onSelectItem={onSelectItem}
                  />
                </SidebarSection>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

