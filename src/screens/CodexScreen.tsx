import { PaneHeader } from "../components/shell/PaneHeader";
import type { Workspace } from "../models/workspace";

interface CodexScreenProps {
  workspace: Workspace;
}

export function CodexScreen({ workspace }: CodexScreenProps) {
  return (
    <section className="workspace-screen">
      <PaneHeader
        eyebrow="Codex"
        title="CLI Session Surface"
        subtitle="Prepared for subprocess-backed terminal streaming without implementing runtime wiring in this step."
      />

      <div className="split-layout">
        <article className="pane-block">
          <h3 className="block-title">Session setup</h3>
          <ul className="compact-list" role="list">
            <li className="compact-row">
              <span className="compact-row-main">Workspace</span>
              <span className="compact-row-meta">{workspace.rootPath}</span>
            </li>
            <li className="compact-row">
              <span className="compact-row-main">Entry command</span>
              <span className="compact-row-meta">codex --workspace .</span>
            </li>
            <li className="compact-row">
              <span className="compact-row-main">Session mode</span>
              <span className="compact-row-meta">Interactive terminal panel</span>
            </li>
          </ul>
        </article>

        <article className="pane-block terminal-pane">
          <h3 className="block-title">Terminal preview</h3>
          <pre>{`$ codex --workspace .\nPreparing shell bridge...\nStreaming output will appear here.`}</pre>
        </article>
      </div>
    </section>
  );
}

