import type { ReactNode } from "react";

interface SidebarSectionProps {
  title: string;
  children: ReactNode;
}

export function SidebarSection({ title, children }: SidebarSectionProps) {
  return (
    <section className="sidebar-section">
      <h3 className="sidebar-section-title">{title}</h3>
      {children}
    </section>
  );
}

