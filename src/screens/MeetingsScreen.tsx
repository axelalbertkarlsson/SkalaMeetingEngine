import { PaneHeader } from "../components/shell/PaneHeader";
import type { Run } from "../models/run";

interface MeetingsScreenProps {
  runs: Run[];
}

export function MeetingsScreen({ runs }: MeetingsScreenProps) {
  const recentMeetingRuns = runs
    .filter((run) => run.type === "meeting_import" || run.type === "meeting_recording")
    .slice(0, 6);

  return (
    <section className="workspace-screen">
      <PaneHeader
        eyebrow="Meetings"
        title="Capture And Import"
        subtitle="Recording/import controls are staged as compact pane actions for later native wiring."
      />

      <div className="split-layout">
        <article className="pane-block">
          <h3 className="block-title">Actions</h3>
          <ul className="compact-list" role="list">
            <li className="compact-row">
              <span className="compact-row-main">New recording</span>
              <span className="compact-row-meta">Mic, system audio, or mixed</span>
            </li>
            <li className="compact-row">
              <span className="compact-row-main">Import meeting</span>
              <span className="compact-row-meta">Audio/video fallback path</span>
            </li>
            <li className="compact-row">
              <span className="compact-row-main">Prepare run</span>
              <span className="compact-row-meta">Attach metadata and workspace context</span>
            </li>
          </ul>
        </article>

        <article className="pane-block">
          <h3 className="block-title">Drafts</h3>
          <ul className="compact-list" role="list">
            <li className="compact-row">
              <span className="compact-row-main">Q2 planning notes</span>
              <span className="compact-row-meta">Draft cleaned transcript</span>
            </li>
            <li className="compact-row">
              <span className="compact-row-main">Retro action extraction</span>
              <span className="compact-row-meta">Owner assignments pending</span>
            </li>
          </ul>
        </article>
      </div>

      <article className="pane-block">
        <h3 className="block-title">Recent meeting runs</h3>
        <ul className="compact-list" role="list">
          {recentMeetingRuns.map((run) => (
            <li key={run.id} className="compact-row">
              <span className="compact-row-main">{run.title}</span>
              <span className="compact-row-meta">{run.status.replace("_", " ")}</span>
            </li>
          ))}
          {recentMeetingRuns.length === 0 && <li className="empty-row muted">No meeting runs yet.</li>}
        </ul>
      </article>
    </section>
  );
}

