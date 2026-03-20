import { GearIcon, MeetingIcon, RunIcon } from "./icons";
import { SidebarList, type SidebarItemData } from "./SidebarList";
import { SidebarSection } from "./SidebarSection";

export interface SidebarGroupData {
  id: string;
  title: string;
  items: SidebarItemData[];
}

interface CollapsibleSidebarProps {
  collapsed: boolean;
  groups: SidebarGroupData[];
  selectedItemId?: string;
  onSelectItem: (itemId: string) => void;
}

export function CollapsibleSidebar(props: CollapsibleSidebarProps) {
  const { collapsed, groups, selectedItemId, onSelectItem } = props;

  return (
    <div className="collapsible-sidebar">
      {!collapsed && (
        <>
          <div className="documents-sidebar-toolbar" role="toolbar" aria-label="Meeting sidebar actions">
            <button type="button" className="documents-sidebar-action" title="Meetings (placeholder)" aria-label="Meetings (placeholder)">
              <MeetingIcon />
            </button>
            <button type="button" className="documents-sidebar-action" title="Runs (placeholder)" aria-label="Runs (placeholder)">
              <RunIcon />
            </button>
            <button type="button" className="documents-sidebar-action" title="Settings (placeholder)" aria-label="Settings (placeholder)">
              <GearIcon />
            </button>
          </div>
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
