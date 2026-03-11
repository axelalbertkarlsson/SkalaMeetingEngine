interface InspectorRow {
  label: string;
  value: string;
  tone?: "neutral" | "warning" | "success" | "danger";
}

export interface InspectorSection {
  id: string;
  title: string;
  rows: InspectorRow[];
}

interface InspectorPaneProps {
  title: string;
  sections: InspectorSection[];
}

export function InspectorPane({ title, sections }: InspectorPaneProps) {
  return (
    <div className="inspector-pane">
      <header className="inspector-header">
        <p className="pane-eyebrow">Inspector</p>
        <h2 className="pane-title">{title}</h2>
      </header>

      <div className="inspector-content">
        {sections.map((section) => (
          <section key={section.id} className="inspector-section">
            <h3>{section.title}</h3>
            <dl>
              {section.rows.map((row) => (
                <div key={`${section.id}-${row.label}`} className="inspector-row">
                  <dt>{row.label}</dt>
                  <dd className={`tone-${row.tone ?? "neutral"}`}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

