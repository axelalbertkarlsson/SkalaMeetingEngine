import { PaneHeader } from "../components/shell/PaneHeader";
import type { Run } from "../models/run";
import type { Workspace } from "../models/workspace";

interface VaultScreenProps {
  workspace: Workspace;
  runs: Run[];
}

export function VaultScreen({ workspace, runs }: VaultScreenProps) {
  const publishQueue = runs.filter((run) => run.status === "needs_review").slice(0, 6);

  return (
    <section className="workspace-screen">
      <PaneHeader
        eyebrow="Vault"
        title="Obsidian Publish Surface"
        subtitle="Vault-oriented staging layout for previews, folders, templates, and publish queue."
      />

      <div className="split-layout">
        <article className="pane-block">
          <h3 className="block-title">Vault info</h3>
          <ul className="compact-list" role="list">
            <li className="compact-row">
              <span className="compact-row-main">Vault path</span>
              <span className="compact-row-meta">{workspace.obsidian.vaultPath}</span>
            </li>
            <li className="compact-row">
              <span className="compact-row-main">Publish folder</span>
              <span className="compact-row-meta">{workspace.obsidian.publishFolder}</span>
            </li>
            <li className="compact-row">
              <span className="compact-row-main">Safe mode</span>
              <span className="compact-row-meta">{workspace.obsidian.safeMode ? "Enabled" : "Disabled"}</span>
            </li>
          </ul>
        </article>

        <article className="pane-block">
          <h3 className="block-title">Templates</h3>
          <ul className="compact-list" role="list">
            <li className="compact-row">
              <span className="compact-row-main">Meeting note template</span>
              <span className="compact-row-meta">Summary, decisions, action items</span>
            </li>
            <li className="compact-row">
              <span className="compact-row-main">Review checklist</span>
              <span className="compact-row-meta">Owners, deadlines, confidence checks</span>
            </li>
          </ul>
        </article>
      </div>

      <article className="pane-block">
        <h3 className="block-title">Publish queue</h3>
        <ul className="compact-list" role="list">
          {publishQueue.map((run) => (
            <li key={run.id} className="compact-row">
              <span className="compact-row-main">{run.title}</span>
              <span className="compact-row-meta">Awaiting explicit publish review</span>
            </li>
          ))}
          {publishQueue.length === 0 && <li className="empty-row muted">No notes queued for publish.</li>}
        </ul>
      </article>
    </section>
  );
}

