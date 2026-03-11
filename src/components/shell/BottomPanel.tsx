export interface BottomPanelView {
  id: string;
  label: string;
  lines: string[];
}

interface BottomPanelProps {
  views: BottomPanelView[];
  activeViewId: string;
  onSelectView: (viewId: string) => void;
}

export function BottomPanel({ views, activeViewId, onSelectView }: BottomPanelProps) {
  const activeView = views.find((view) => view.id === activeViewId) ?? views[0];

  return (
    <div className="bottom-panel">
      <div className="bottom-panel-tabs" role="tablist" aria-label="Bottom panel views">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={view.id === activeView.id}
            className={view.id === activeView.id ? "bottom-panel-tab active" : "bottom-panel-tab"}
            onClick={() => onSelectView(view.id)}
          >
            {view.label}
          </button>
        ))}
      </div>

      <pre className="bottom-panel-output">{activeView.lines.join("\n")}</pre>
    </div>
  );
}

