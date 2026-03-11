import type { SVGProps } from "react";

function BaseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function HomeIcon() {
  return (
    <BaseIcon>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </BaseIcon>
  );
}

export function MeetingIcon() {
  return (
    <BaseIcon>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M3 10h18" />
    </BaseIcon>
  );
}

export function RunIcon() {
  return (
    <BaseIcon>
      <path d="M4 4h16v6H4z" />
      <path d="M4 14h16v6H4z" />
      <path d="M8 7h8" />
      <path d="M8 17h8" />
    </BaseIcon>
  );
}

export function VaultIcon() {
  return (
    <BaseIcon>
      <path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M3 9h18" />
    </BaseIcon>
  );
}

export function CodeIcon() {
  return (
    <BaseIcon>
      <path d="m8 8-4 4 4 4" />
      <path d="m16 8 4 4-4 4" />
      <path d="m13 5-2 14" />
    </BaseIcon>
  );
}

export function GearIcon() {
  return (
    <BaseIcon>
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="M4.7 12a7.3 7.3 0 0 1 .1-1.2l-1.9-1.5 1.7-3 2.3.6a7.5 7.5 0 0 1 2-1.2L9.3 3h5.4l.4 2.7c.7.3 1.4.7 2 1.2l2.3-.6 1.7 3-1.9 1.5c.1.4.1.8.1 1.2s0 .8-.1 1.2l1.9 1.5-1.7 3-2.3-.6a7.5 7.5 0 0 1-2 1.2l-.4 2.7H9.3l-.4-2.7a7.5 7.5 0 0 1-2-1.2l-2.3.6-1.7-3 1.9-1.5A7.3 7.3 0 0 1 4.7 12Z" />
    </BaseIcon>
  );
}

export function PanelLeftIcon() {
  return (
    <BaseIcon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </BaseIcon>
  );
}

export function PanelRightIcon() {
  return (
    <BaseIcon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </BaseIcon>
  );
}

export function PanelBottomIcon() {
  return (
    <BaseIcon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 14h18" />
    </BaseIcon>
  );
}

export function SunIcon() {
  return (
    <BaseIcon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="m4.9 4.9 2.1 2.1" />
      <path d="m17 17 2.1 2.1" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
      <path d="m4.9 19.1 2.1-2.1" />
      <path d="m17 7 2.1-2.1" />
    </BaseIcon>
  );
}

export function MoonIcon() {
  return (
    <BaseIcon>
      <path d="M20 14.8A8.5 8.5 0 1 1 9.2 4a7 7 0 0 0 10.8 10.8Z" />
    </BaseIcon>
  );
}

export function FolderIcon() {
  return (
    <BaseIcon>
      <path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M3 9h18" />
    </BaseIcon>
  );
}

export function WindowMinimizeIcon() {
  return (
    <BaseIcon>
      <path d="M5 12h14" />
    </BaseIcon>
  );
}

export function WindowMaximizeIcon() {
  return (
    <BaseIcon>
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </BaseIcon>
  );
}

export function WindowRestoreIcon() {
  return (
    <BaseIcon>
      <path d="M8 8h10v10H8z" />
      <path d="M6 16V6h10" />
    </BaseIcon>
  );
}

export function WindowCloseIcon() {
  return (
    <BaseIcon>
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </BaseIcon>
  );
}
