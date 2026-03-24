import { sampleCalendarSnapshots } from "../../data/sampleCalendar";
import { loadCalendarSourceSnapshots } from "../../lib/calendarApi";
import type {
  CalendarDataSnapshot,
  CalendarLoadRange,
  CalendarSourceSnapshot
} from "../../models/calendar";
import type { Workspace } from "../../models/workspace";
import { buildEventsFromIcsSnapshot } from "./ics";

interface CalendarProvider {
  id: "ics";
  supports(snapshot: CalendarSourceSnapshot): boolean;
  loadEvents(snapshot: CalendarSourceSnapshot, range: CalendarLoadRange): ReturnType<typeof buildEventsFromIcsSnapshot>;
}

const providers: CalendarProvider[] = [
  {
    id: "ics",
    supports: (snapshot) => snapshot.source.provider === "ics",
    loadEvents: (snapshot, range) => buildEventsFromIcsSnapshot(snapshot, range)
  }
];

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadCalendarData(
  workspace: Workspace,
  range: CalendarLoadRange
): Promise<CalendarDataSnapshot> {
  const sourceSnapshots = isTauriRuntime()
    ? await loadCalendarSourceSnapshots({
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath
      })
    : sampleCalendarSnapshots;

  const events = sourceSnapshots.flatMap((snapshot) => {
    const provider = providers.find((entry) => entry.supports(snapshot));
    if (!provider || !snapshot.content) {
      return [];
    }

    return provider.loadEvents(snapshot, range);
  });

  return {
    sources: sourceSnapshots,
    events: events.sort((left, right) => {
      const startDiff =
        new Date(left.occurrenceStartAt).getTime() - new Date(right.occurrenceStartAt).getTime();
      if (startDiff !== 0) {
        return startDiff;
      }

      return left.title.localeCompare(right.title);
    }),
    range,
    generatedAt: new Date().toISOString()
  };
}
