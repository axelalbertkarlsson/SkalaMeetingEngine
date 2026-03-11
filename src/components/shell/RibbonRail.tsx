import type { ReactNode } from "react";
import { RibbonButton } from "./RibbonButton";

export interface RibbonSection {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface RibbonUtilityAction {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  onClick: () => void;
}

interface RibbonRailProps {
  sections: RibbonSection[];
  activeSectionId: string;
  onSelectSection: (sectionId: string) => void;
  utilityActions: RibbonUtilityAction[];
}

export function RibbonRail({ sections, activeSectionId, onSelectSection, utilityActions }: RibbonRailProps) {
  return (
    <nav className="ribbon-rail" aria-label="Primary sections">
      <div className="ribbon-group">
        {sections.map((section) => (
          <RibbonButton
            key={section.id}
            icon={section.icon}
            label={section.label}
            active={section.id === activeSectionId}
            onClick={() => onSelectSection(section.id)}
          />
        ))}
      </div>

      <div className="ribbon-group ribbon-group-bottom">
        {utilityActions.map((action) => (
          <RibbonButton
            key={action.id}
            icon={action.icon}
            label={action.label}
            active={action.active}
            onClick={action.onClick}
          />
        ))}
      </div>
    </nav>
  );
}

