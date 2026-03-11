import type { ReactNode } from "react";

interface RibbonButtonProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}

export function RibbonButton({ icon, label, active = false, onClick }: RibbonButtonProps) {
  return (
    <button
      type="button"
      className={active ? "ribbon-button active" : "ribbon-button"}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <span className="ribbon-button-icon" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
}

