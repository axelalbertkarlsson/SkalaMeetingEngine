import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarAgenda } from "../components/meetings/CalendarAgenda";
import { CalendarMonthView } from "../components/meetings/CalendarMonthView";
import { CalendarTimeGrid } from "../components/meetings/CalendarTimeGrid";
import { MeetingDetailDialog } from "../components/meetings/MeetingDetailDialog";
import { GearIcon } from "../components/shell/icons";
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

type MeetingsSettingsSection = "sources-subscriptions" | "sources-imports" | "upcoming";

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
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [settingsTargetSection, setSettingsTargetSection] = useState<MeetingsSettingsSection | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsPanelRef = useRef<HTMLElement | null>(null);
  const subscriptionSectionRef = useRef<HTMLDivElement | null>(null);
  const importSectionRef = useRef<HTMLDivElement | null>(null);
  const upcomingSectionRef = useRef<HTMLDivElement | null>(null);

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

    if (sidebarSelection === "meetings-focus-upcoming") {
      setSettingsPanelOpen(true);
      setSettingsTargetSection("upcoming");
    }

    if (sidebarSelection === "meetings-source-ics") {
      setSettingsPanelOpen(true);
      setSettingsTargetSection("sources-subscriptions");
    }

    if (sidebarSelection === "meetings-source-imports") {
      setSettingsPanelOpen(true);
      setSettingsTargetSection("sources-imports");
    }
  }, [setViewMode, sidebarSelection]);

  useEffect(() => {
    if (!settingsPanelOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsPanelOpen(false);
        setSettingsTargetSection(null);
      }
    };

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (settingsPanelRef.current?.contains(target) || settingsButtonRef.current?.contains(target)) {
        return;
      }

      setSettingsPanelOpen(false);
      setSettingsTargetSection(null);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [settingsPanelOpen]);

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
    if (!settingsPanelOpen || !settingsTargetSection) {
      return;
    }

    const target =
      settingsTargetSection === "sources-imports"
        ? importSectionRef.current
        : settingsTargetSection === "upcoming"
          ? upcomingSectionRef.current
          : subscriptionSectionRef.current;

    if (!target) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [settingsPanelOpen, settingsTargetSection]);

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

  const openSettingsPanel = useCallback((target: MeetingsSettingsSection = "sources-subscriptions") => {
    setSettingsPanelOpen(true);
    setSettingsTargetSection(target);
  }, []);

  const closeSettingsPanel = useCallback(() => {
    setSettingsPanelOpen(false);
    setSettingsTargetSection(null);
  }, []);

  const toggleSettingsPanel = useCallback(() => {
    if (settingsPanelOpen) {
      closeSettingsPanel();
      return;
    }

    openSettingsPanel();
  }, [closeSettingsPanel, openSettingsPanel, settingsPanelOpen]);

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
            <button
              ref={settingsButtonRef}
              type="button"
              className={[
                "meeting-calendar-toolbar-button",
                "meeting-calendar-toolbar-button-icon",
                settingsPanelOpen ? "active" : ""
              ].join(" ")}
              aria-label="Open meetings settings"
              aria-controls="meetings-settings-panel"
              aria-expanded={settingsPanelOpen}
              onClick={toggleSettingsPanel}
            >
              <GearIcon />
            </button>
          </div>
        }
      />

      {settingsPanelOpen ? (
        <div className="meeting-calendar-settings-tray">
          <section
            ref={settingsPanelRef}
            id="meetings-settings-panel"
            className="meeting-calendar-settings-panel"
            aria-label="Meetings settings"
          >
            <div className="meeting-calendar-settings-panel-header">
              <div>
                <p className="pane-eyebrow">Meetings settings</p>
                <h3 className="meeting-calendar-settings-panel-title">Sources and upcoming</h3>
                <p className="muted">Manage ICS sources without giving up calendar space.</p>
              </div>
              <button type="button" className="meeting-detail-close" onClick={closeSettingsPanel}>
                Close
              </button>
            </div>

            <div className="meeting-calendar-settings-panel-scroll">
              <section className="meeting-calendar-side-panel meeting-calendar-settings-section">
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
                    <p className="muted">
                      No calendar sources yet. Add an ICS subscription or import a file to populate the Meetings tab.
                    </p>
                  ) : null}
                </div>

                <div ref={subscriptionSectionRef} className="meeting-calendar-settings-target">
                  <div className="meeting-calendar-source-form">
                    <h4 className="block-title">Add subscription</h4>
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
                </div>

                <div ref={importSectionRef} className="meeting-calendar-settings-target">
                  <div className="meeting-calendar-source-form">
                    <h4 className="block-title">Import calendar</h4>
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
                </div>
              </section>

              <div ref={upcomingSectionRef} className="meeting-calendar-settings-target">
                <CalendarAgenda
                  events={upcomingEvents}
                  selectedEventId={selectedEventId}
                  onSelectEvent={handleSelectEvent}
                />
              </div>
            </div>
          </section>
        </div>
      ) : null}

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
      </div>

      <MeetingDetailDialog event={selectedEvent} onClose={() => setSelectedEventId(null)} />
    </section>
  );
}
