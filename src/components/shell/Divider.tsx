interface DividerProps {
  orientation?: "horizontal" | "vertical";
}

export function Divider({ orientation = "horizontal" }: DividerProps) {
  return <div className={`divider divider-${orientation}`} aria-hidden="true" />;
}

