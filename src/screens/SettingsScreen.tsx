import { PaneHeader } from "../components/shell/PaneHeader";
import type { Workspace } from "../models/workspace";

interface SettingsScreenProps {
  workspace: Workspace;
  selectedCategory: string;
}

export function SettingsScreen({ workspace, selectedCategory }: SettingsScreenProps) {
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
      description: "Shell readiness for local Codex CLI sessions.",
      rows: [
        { label: "Execution mode", value: "Local subprocess (planned)" },
        { label: "Workspace binding", value: workspace.rootPath },
        { label: "Output surface", value: "Bottom panel and terminal pane" }
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

