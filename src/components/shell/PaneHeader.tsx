import type { ReactNode } from "react";

interface PaneHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PaneHeader({ eyebrow, title, subtitle, actions }: PaneHeaderProps) {
  return (
    <header className="pane-header">
      <div>
        {eyebrow && <p className="pane-eyebrow">{eyebrow}</p>}
        <h2 className="pane-title">{title}</h2>
        {subtitle && <p className="pane-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="pane-header-actions">{actions}</div>}
    </header>
  );
}

