import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarAgenda } from "../components/meetings/CalendarAgenda";
import { CalendarMonthView } from "../components/meetings/CalendarMonthView";
import { CalendarTimeGrid } from "../components/meetings/CalendarTimeGrid";
import { MeetingDetailDialog } from "../components/meetings/MeetingDetailDialog";
import { PaneHeader } from "../components/shell/PaneHeader";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import {
  addCalendarSubscription,
  importCalendarSource,
  removeCalendarSource
} from "../lib/calendarApi";
import type {
  CalendarDataSnapshot,
  CalendarEventOccurrence,
  CalendarViewMode
} from "../models/calendar";
import type { Workspace } from "../models/workspace";
import {
  addDays,
  addMonths,
  addYears,
  endOfDay,
  endOfWeek,
  getMonthGridEnd,
  getMonthGridStart,
  startOfDay,
  startOfWeek
} from "../services/calendar/dateTime";
import { loadCalendarData } from "../services/calendar/calendarService";

interface MeetingsScreenProps {
  workspace: Workspace;
  sidebarSelection?: string;
}

function getVisibleRange(viewMode: CalendarViewMode, anchorDate: Date) {
  if (viewMode === "month") {
    return {
      start: getMonthGridStart(anchorDate),
      end: getMonthGridEnd(anchorDate)
    };
  }

  if (viewMode === "week") {
    return {
      start: startOfWeek(anchorDate),
      end: endOfWeek(anchorDate)
    };
  }

  return {
    start: startOfDay(anchorDate),
    end: endOfDay(anchorDate)
  };
}

function getLoadRange(viewMode: CalendarViewMode, anchorDate: Date) {
  const visibleRange = getVisibleRange(viewMode, anchorDate);
  const now = new Date();

  return {
    startAt: addDays(
      visibleRange.start < startOfDay(now) ? visibleRange.start : startOfDay(now),
      -7
    ).toISOString(),
    endAt: addDays(
      visibleRange.end > addDays(now, 30) ? visibleRange.end : addDays(now, 30),
      14
    ).toISOString()
  };
}

function shiftAnchorDate(viewMode: CalendarViewMode, anchorDate: Date, direction: -1 | 1) {
  if (viewMode === "month") {
    return addMonths(anchorDate, direction);
  }

  if (viewMode === "week") {
    return addDays(anchorDate, direction * 7);
  }

  return addDays(anchorDate, direction);
}

function formatRangeLabel(viewMode: CalendarViewMode, anchorDate: Date) {
  if (viewMode === "month") {
    return anchorDate.toLocaleDateString([], { month: "long", year: "numeric" });
  }

  if (viewMode === "week") {
    const start = startOfWeek(anchorDate);
    const end = addDays(endOfWeek(anchorDate), -1);
    return `${start.toLocaleDateString([], {
      month: "short",
      day: "numeric"
    })} - ${end.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric"
    })}`;
  }

  return anchorDate.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function eventIntersectsRange(event: CalendarEventOccurrence, start: Date, end: Date) {
  return new Date(event.occurrenceStartAt) < end && new Date(event.occurrenceEndAt) > start;
}

export function MeetingsScreen({ workspace, sidebarSelection }: MeetingsScreenProps) {
  const [viewMode, setViewMode] = useLocalStorageState<CalendarViewMode>(
    "meetings.calendarView",
    "month"
  );
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [calendarData, setCalendarData] = useState<CalendarDataSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [subscriptionName, setSubscriptionName] = useState("");
  const [subscriptionUrl, setSubscriptionUrl] = useState("");
  const [importName, setImportName] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const visibleRange = useMemo(() => getVisibleRange(viewMode, anchorDate), [anchorDate, viewMode]);
  const loadRange = useMemo(() => getLoadRange(viewMode, anchorDate), [anchorDate, viewMode]);

  const refreshCalendar = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await loadCalendarData(workspace, loadRange);
      setCalendarData(snapshot);
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(`Failed to load calendars: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [loadRange, workspace]);

  useEffect(() => {
    void refreshCalendar();
  }, [refreshCalendar]);

  useEffect(() => {
    if (!sidebarSelection) {
      return;
    }

    if (sidebarSelection === "meetings-view-month") {
      setViewMode("month");
    }
    if (sidebarSelection === "meetings-view-week") {
      setViewMode("week");
    }
    if (sidebarSelection === "meetings-view-day") {
      setViewMode("day");
    }
    if (sidebarSelection === "meetings-focus-today") {
      const today = new Date();
      setSelectedDate(today);
      setAnchorDate(today);
    }
  }, [setViewMode, sidebarSelection]);

  const visibleEvents = useMemo(
    () =>
      (calendarData?.events ?? []).filter((event) =>
        eventIntersectsRange(event, visibleRange.start, visibleRange.end)
      ),
    [calendarData?.events, visibleRange.end, visibleRange.start]
  );
  const upcomingEvents = useMemo(
    () =>
      (calendarData?.events ?? [])
        .filter((event) => new Date(event.occurrenceEndAt) > new Date())
        .slice(0, 12),
    [calendarData?.events]
  );
  const selectedEvent = useMemo(
    () => calendarData?.events.find((event) => event.instanceId === selectedEventId) ?? null,
    [calendarData?.events, selectedEventId]
  );

  useEffect(() => {
    if (selectedEventId && !calendarData?.events.some((event) => event.instanceId === selectedEventId)) {
      setSelectedEventId(null);
    }
  }, [calendarData?.events, selectedEventId]);

  const handleSelectDate = (date: Date) => {
    setSelectedDate(date);
    setAnchorDate(date);
  };

  const handleSelectEvent = (event: CalendarEventOccurrence) => {
    setSelectedEventId(event.instanceId);
    setSelectedDate(new Date(event.occurrenceStartAt));
    setAnchorDate(new Date(event.occurrenceStartAt));
  };

  const handleAddSubscription = async () => {
    setBusyAction("subscription");
    try {
      await addCalendarSubscription(
        { workspaceId: workspace.id, workspaceRoot: workspace.rootPath },
        {
          name: subscriptionName.trim() || "Calendar subscription",
          url: subscriptionUrl.trim()
        }
      );
      setSubscriptionName("");
      setSubscriptionUrl("");
      setStatusMessage("Calendar subscription added.");
      await refreshCalendar();
    } catch (error) {
      setStatusMessage(`Failed to add subscription: ${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleImportCalendarFile = async (file: File) => {
    setBusyAction("import");
    try {
      await importCalendarSource(
        { workspaceId: workspace.id, workspaceRoot: workspace.rootPath },
        {
          name: importName.trim() || file.name.replace(/\.ics$/i, ""),
          file
        }
      );
      setImportName("");
      setStatusMessage(`Imported ${file.name}.`);
      await refreshCalendar();
    } catch (error) {
      setStatusMessage(`Failed to import calendar file: ${String(error)}`);
    } finally {
      setBusyAction(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleRemoveSource = async (sourceId: string) => {
    setBusyAction(sourceId);
    try {
      await removeCalendarSource(workspace.rootPath, sourceId);
      setStatusMessage("Calendar source removed.");
      await refreshCalendar();
    } catch (error) {
      setStatusMessage(`Failed to remove calendar source: ${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="workspace-screen meetings-calendar-screen">
      <PaneHeader
        eyebrow="Meetings"
        title="Calendar"
        subtitle="ICS-powered calendar views for planning, review, and meeting launch context."
        actions={
          <div className="meeting-calendar-pane-actions">
            <button
              type="button"
              className="meeting-calendar-toolbar-button"
              onClick={() => {
                const today = new Date();
                setAnchorDate(today);
                setSelectedDate(today);
              }}
            >
              Today
            </button>
            <button
              type="button"
              className="meeting-calendar-toolbar-button"
              onClick={() => setAnchorDate((current) => shiftAnchorDate(viewMode, current, -1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="meeting-calendar-toolbar-button"
              onClick={() => setAnchorDate((current) => shiftAnchorDate(viewMode, current, 1))}
            >
              Next
            </button>
            <button
              type="button"
              className="meeting-calendar-toolbar-button"
              onClick={() => void refreshCalendar()}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        }
      />

      <article className="pane-block meeting-calendar-toolbar-block">
        <div className="meeting-calendar-toolbar-main">
          <div>
            <p className="pane-eyebrow">Range</p>
            <h3 className="meeting-calendar-range-label">{formatRangeLabel(viewMode, anchorDate)}</h3>
          </div>
          <div className="meeting-calendar-view-switcher" role="tablist" aria-label="Calendar view">
            {(["month", "week", "day"] as CalendarViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={viewMode === mode}
                className={viewMode === mode ? "meeting-calendar-view-tab active" : "meeting-calendar-view-tab"}
                onClick={() => setViewMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
        <p className="muted">
          {statusMessage ??
            `${calendarData?.sources.length ?? 0} sources loaded. ${
              visibleEvents.length
            } meetings in the current view.`}
        </p>
      </article>

      <div className="meeting-calendar-layout">
        <div className="meeting-calendar-main">
          {viewMode === "month" ? (
            <CalendarMonthView
              anchorDate={anchorDate}
              selectedDate={selectedDate}
              events={visibleEvents}
              selectedEventId={selectedEventId}
              onSelectDate={handleSelectDate}
              onSelectEvent={handleSelectEvent}
            />
          ) : (
            <CalendarTimeGrid
              mode={viewMode}
              anchorDate={anchorDate}
              events={visibleEvents}
              selectedEventId={selectedEventId}
              onSelectDate={handleSelectDate}
              onSelectEvent={handleSelectEvent}
            />
          )}
        </div>

        <aside className="meeting-calendar-sidebar">
          <section className="meeting-calendar-side-panel">
            <div className="meeting-calendar-side-panel-header">
              <h3 className="block-title">Sources</h3>
              <p className="muted">ICS imports and subscriptions feeding the calendar.</p>
            </div>

            <div className="meeting-calendar-source-list">
              {(calendarData?.sources ?? []).map((sourceSnapshot) => (
                <article key={sourceSnapshot.source.id} className="meeting-calendar-source-card">
                  <div className="meeting-calendar-source-copy">
                    <strong>{sourceSnapshot.source.name}</strong>
                    <span className="muted">
                      {sourceSnapshot.source.kind === "ics_subscription" ? "Subscription" : "Imported file"}
                    </span>
                    {sourceSnapshot.error ? (
                      <span className="meeting-calendar-source-state warning">{sourceSnapshot.error}</span>
                    ) : sourceSnapshot.stale ? (
                      <span className="meeting-calendar-source-state warning">Using cached data</span>
                    ) : (
                      <span className="meeting-calendar-source-state success">
                        {sourceSnapshot.source.lastSyncedAt
                          ? `Synced ${new Date(sourceSnapshot.source.lastSyncedAt).toLocaleString()}`
                          : "Ready"}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="meeting-calendar-toolbar-button danger"
                    onClick={() => void handleRemoveSource(sourceSnapshot.source.id)}
                    disabled={busyAction === sourceSnapshot.source.id}
                  >
                    Remove
                  </button>
                </article>
              ))}

              {(calendarData?.sources.length ?? 0) === 0 ? (
                <p className="muted">No calendar sources yet. Add an ICS subscription or import a file to populate the Meetings tab.</p>
              ) : null}
            </div>

            <div className="meeting-calendar-source-form">
              <label className="meeting-field">
                <span>Subscription name</span>
                <input
                  className="settings-text-input"
                  type="text"
                  value={subscriptionName}
                  onChange={(event) => setSubscriptionName(event.target.value)}
                  placeholder="Team calendar"
                />
              </label>
              <label className="meeting-field">
                <span>ICS URL</span>
                <input
                  className="settings-text-input"
                  type="url"
                  value={subscriptionUrl}
                  onChange={(event) => setSubscriptionUrl(event.target.value)}
                  placeholder="https://calendar.example.com/team.ics"
                />
              </label>
              <button
                type="button"
                className="codex-terminal-button"
                onClick={() => void handleAddSubscription()}
                disabled={busyAction !== null || !subscriptionUrl.trim()}
              >
                {busyAction === "subscription" ? "Adding..." : "Add subscription"}
              </button>
            </div>

            <div className="meeting-calendar-source-form">
              <label className="meeting-field">
                <span>Import label</span>
                <input
                  className="settings-text-input"
                  type="text"
                  value={importName}
                  onChange={(event) => setImportName(event.target.value)}
                  placeholder="Personal calendar"
                />
              </label>
              <label className="meeting-file-button">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ics,text/calendar"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void handleImportCalendarFile(file);
                    }
                  }}
                  disabled={busyAction !== null}
                />
                <span>{busyAction === "import" ? "Importing..." : "Import .ics file"}</span>
              </label>
            </div>
          </section>

          <CalendarAgenda
            events={upcomingEvents}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        </aside>
      </div>

      <MeetingDetailDialog event={selectedEvent} onClose={() => setSelectedEventId(null)} />
    </section>
  );
}
