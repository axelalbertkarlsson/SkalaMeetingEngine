import { useMemo, useState } from "react";
import { PaneHeader } from "../components/shell/PaneHeader";
import type { Run } from "../models/run";

interface RunsScreenProps {
  runs: Run[];
}

export function RunsScreen({ runs }: RunsScreenProps) {
  const [selectedRunId, setSelectedRunId] = useState<string>(runs[0]?.id ?? "");

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0],
    [runs, selectedRunId]
  );

  return (
    <section className="workspace-screen">
      <PaneHeader
        eyebrow="Runs"
        title="Run History"
        subtitle="List/detail layout prepared for filtering, artifact browsing, and review checkpoints."
      />

      <div className="runs-layout">
        <article className="pane-block run-list-pane">
          <div className="table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className={run.id === selectedRun?.id ? "selected" : ""}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <td>{run.title}</td>
                    <td>{run.status.replace("_", " ")}</td>
                    <td>{run.type.replace("_", " ")}</td>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="pane-block run-detail-pane">
          <h3 className="block-title">Details</h3>
          {selectedRun ? (
            <dl className="detail-list">
              <div>
                <dt>Title</dt>
                <dd>{selectedRun.title}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selectedRun.status.replace("_", " ")}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{selectedRun.type.replace("_", " ")}</dd>
              </div>
              <div>
                <dt>Artifacts</dt>
                <dd>{selectedRun.artifactIds.length}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{new Date(selectedRun.startedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Ended</dt>
                <dd>{selectedRun.endedAt ? new Date(selectedRun.endedAt).toLocaleString() : "In progress"}</dd>
              </div>
              <div>
                <dt>Summary</dt>
                <dd>{selectedRun.summary ?? "No summary yet."}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">No run selected.</p>
          )}
        </article>
      </div>
    </section>
  );
}

