import { useEffect, useState } from "react";
import { PaneHeader } from "../components/shell/PaneHeader";
import type { Workspace } from "../models/workspace";

interface SettingsScreenProps {
  workspace: Workspace;
  selectedCategory: string;
  codexCommandPath: string;
  onCodexCommandPathChange: (value: string) => void;
}

const codexPathSuggestions = [
  "codex",
  "C:/Users/AxelKarlsson/AppData/Roaming/npm/codex.cmd",
  "C:/Users/AxelKarlsson/AppData/Roaming/npm/codex.ps1",
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.306.996.0_x64__2p2nqsd0c76g0/app/Codex.exe",
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.306.996.0_x64__2p2nqsd0c76g0/app/resources/codex.exe"
];

export function SettingsScreen({
  workspace,
  selectedCategory,
  codexCommandPath,
  onCodexCommandPathChange
}: SettingsScreenProps) {
  const [draftCodexPath, setDraftCodexPath] = useState(codexCommandPath);

  useEffect(() => {
    setDraftCodexPath(codexCommandPath);
  }, [codexCommandPath]);

  const categoryCopy: Record<
    string,
    {
      title: string;
      description: string;
      rows: Array<{ label: string; value: string }>;
    }
  > = {
    "settings-general": {
      title: "General",
      description: "Core shell and behavior defaults for the desktop workbench.",
      rows: [
        { label: "Theme", value: "Dark-first with light option" },
        { label: "Layout", value: "Two-part sidebar + workspace panes" },
        { label: "Density", value: "Compact desktop" }
      ]
    },
    "settings-workspace": {
      title: "Workspace",
      description: "Workspace paths and run defaults.",
      rows: [
        { label: "Name", value: workspace.name },
        { label: "Root path", value: workspace.rootPath },
        { label: "Status", value: workspace.status }
      ]
    },
    "settings-vault": {
      title: "Vault",
      description: "Review-first publish targeting for Obsidian.",
      rows: [
        { label: "Vault path", value: workspace.obsidian.vaultPath },
        { label: "Publish folder", value: workspace.obsidian.publishFolder },
        { label: "Safe mode", value: workspace.obsidian.safeMode ? "Enabled" : "Disabled" }
      ]
    },
    "settings-transcription": {
      title: "Transcription",
      description: "Provider configuration is scaffolded for later implementation.",
      rows: [
        { label: "Primary provider", value: "OpenAI (planned)" },
        { label: "Fallbacks", value: "Additional providers later" },
        { label: "Job lifecycle", value: "Queued ? running ? review" }
      ]
    },
    "settings-codex": {
      title: "Codex",
      description: "Configure the executable used by the embedded terminal session.",
      rows: [
        { label: "Execution mode", value: "Local subprocess" },
        { label: "Workspace binding", value: workspace.rootPath },
        { label: "Configured command", value: codexCommandPath || "codex" }
      ]
    }
  };

  const content = categoryCopy[selectedCategory] ?? categoryCopy["settings-general"];

  return (
    <section className="workspace-screen">
      <PaneHeader eyebrow="Settings" title={content.title} subtitle={content.description} />

      <article className="pane-block">
        <dl className="detail-list">
          {content.rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </article>

      {selectedCategory === "settings-codex" && (
        <article className="pane-block">
          <h3 className="block-title">Codex executable path</h3>
          <p className="muted settings-help-copy">
            Set the command or full executable path used when starting a Codex session. On Windows,
            <code>codex.cmd</code> and <code>codex.ps1</code> paths are handled automatically.
          </p>

          <div className="settings-input-row">
            <input
              className="settings-text-input"
              type="text"
              value={draftCodexPath}
              onChange={(event) => setDraftCodexPath(event.target.value)}
              placeholder="codex"
              spellCheck={false}
            />
            <button
              type="button"
              className="codex-terminal-button"
              onClick={() => onCodexCommandPathChange(draftCodexPath.trim())}
            >
              Apply
            </button>
          </div>

          <div className="settings-quick-paths">
            {codexPathSuggestions.map((path) => (
              <button
                key={path}
                type="button"
                className="settings-path-button"
                onClick={() => {
                  setDraftCodexPath(path);
                  onCodexCommandPathChange(path);
                }}
              >
                {path}
              </button>
            ))}
          </div>
        </article>
      )}

      <article className="pane-block">
        <h3 className="block-title">Review-first note</h3>
        <p className="muted">
          Settings remain conservative in v1: explicit review checkpoints, no silent vault overwrites, and
          backend integrations added incrementally.
        </p>
      </article>
    </section>
  );
}
