export interface SidebarItemData {
  id: string;
  label: string;
  meta?: string;
  tone?: "neutral" | "warning" | "success" | "danger";
}

interface SidebarListProps {
  items: SidebarItemData[];
  selectedItemId?: string;
  onSelectItem: (itemId: string) => void;
}

export function SidebarList({ items, selectedItemId, onSelectItem }: SidebarListProps) {
  if (items.length === 0) {
    return <p className="sidebar-empty">No items yet.</p>;
  }

  return (
    <ul className="sidebar-list" role="list">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={item.id === selectedItemId ? "sidebar-row active" : "sidebar-row"}
            onClick={() => onSelectItem(item.id)}
          >
            <span className="sidebar-row-main">{item.label}</span>
            {item.meta && <span className={`sidebar-row-meta tone-${item.tone ?? "neutral"}`}>{item.meta}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

