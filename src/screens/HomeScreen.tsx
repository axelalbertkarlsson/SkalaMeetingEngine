import { PaneHeader } from "../components/shell/PaneHeader";
import type { Run } from "../models/run";
import type { Workspace } from "../models/workspace";

interface HomeScreenProps {
  workspace: Workspace;
  runs: Run[];
  stats: {
    total: number;
    openReviewCount: number;
    runningCount: number;
  };
}

function isActiveRun(run: Run) {
  return ["queued", "running", "capturing", "queued_for_transcription", "transcribing", "cleaning"].includes(
    run.status
  );
}

export function HomeScreen({ workspace, runs, stats }: HomeScreenProps) {
  const recentRuns = runs.slice(0, 5);
  const continueWorking = runs.filter((run) => isActiveRun(run) || run.status === "needs_review");
  const reviewQueue = runs.filter((run) => run.status === "needs_review");

  return (
    <section className="workspace-screen">
      <PaneHeader
        eyebrow="Home"
        title={workspace.name}
        subtitle="Recent activity, in-progress work, and review queue in one dense workspace view."
      />

      <div className="split-layout">
        <article className="pane-block">
          <h3 className="block-title">Recent runs ({stats.total})</h3>
          <ul className="compact-list" role="list">
            {recentRuns.map((run) => (
              <li key={run.id} className="compact-row">
                <span className="compact-row-main">{run.title}</span>
                <span className="compact-row-meta">{new Date(run.startedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="pane-block">
          <h3 className="block-title">Continue working ({continueWorking.length})</h3>
          <ul className="compact-list" role="list">
            {continueWorking.map((run) => (
              <li key={run.id} className="compact-row">
                <span className="compact-row-main">{run.title}</span>
                <span className="compact-row-meta">{run.status.replace("_", " ")}</span>
              </li>
            ))}
            {continueWorking.length === 0 && <li className="empty-row muted">No active work items.</li>}
          </ul>
        </article>
      </div>

      <article className="pane-block">
        <h3 className="block-title">Awaiting review ({reviewQueue.length})</h3>
        <ul className="compact-list" role="list">
          {reviewQueue.map((run) => (
            <li key={run.id} className="compact-row">
              <span className="compact-row-main">{run.title}</span>
              <span className="compact-row-meta">{run.summary ?? "Review before publish"}</span>
            </li>
          ))}
          {reviewQueue.length === 0 && <li className="empty-row muted">No review items.</li>}
        </ul>
      </article>
    </section>
  );
}
