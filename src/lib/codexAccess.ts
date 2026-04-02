import type { CodexAccessMode } from "../models/codex.js";

export interface CodexAccessOption {
  mode: CodexAccessMode;
  label: string;
  description: string;
}

export const CODEX_ACCESS_OPTIONS: CodexAccessOption[] = [
  {
    mode: "restricted",
    label: "Restricted",
    description: "Read files and edit only inside the workspace without approval prompts."
  },
  {
    mode: "ask",
    label: "Ask First",
    description: "Stay in the workspace sandbox, but let Codex request approval for commands that need more access."
  },
  {
    mode: "full_access",
    label: "Full Access",
    description: "Allow unrestricted local file and command access for this Codex session."
  }
];

export function getCodexAccessOption(mode: CodexAccessMode | null | undefined) {
  return CODEX_ACCESS_OPTIONS.find((option) => option.mode === mode) ?? CODEX_ACCESS_OPTIONS[0];
}
