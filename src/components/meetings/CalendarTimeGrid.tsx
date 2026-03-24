import type { CalendarEventOccurrence } from "../../models/calendar";
import { addDays, endOfDay, minutesSinceStartOfDay, startOfDay, startOfWeek } from "../../services/calendar/dateTime";

interface CalendarTimeGridProps {
  mode: "week" | "day";
  anchorDate: Date;
  events: CalendarEventOccurrence[];
  selectedEventId?: string | null;
  onSelectDate: (date: Date) => void;
  onSelectEvent: (event: CalendarEventOccurrence) => void;
}

interface PositionedEvent {
  event: CalendarEventOccurrence;
  topPercent: number;
  heightPercent: number;
  leftPercent: number;
  widthPercent: number;
}

const hourLabels = Array.from({ length: 24 }, (_, index) =>
  `${String(index).padStart(2, "0")}:00`
);

function touchesDay(event: CalendarEventOccurrence, dayStart: Date, dayEnd: Date) {
  return new Date(event.occurrenceStartAt) < dayEnd && new Date(event.occurrenceEndAt) > dayStart;
}

function layoutDayEvents(events: CalendarEventOccurrence[], dayStart: Date, dayEnd: Date) {
  const sorted = [...events].sort(
    (left, right) =>
      new Date(left.occurrenceStartAt).getTime() - new Date(right.occurrenceStartAt).getTime()
  );
  const active: Array<{ layout: PositionedEvent; end: number; column: number }> = [];
  const layouts: PositionedEvent[] = [];

  for (const event of sorted) {
    const start = Math.max(new Date(event.occurrenceStartAt).getTime(), dayStart.getTime());
    const end = Math.min(new Date(event.occurrenceEndAt).getTime(), dayEnd.getTime());

    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].end <= start) {
        active.splice(index, 1);
      }
    }

    let column = 0;
    while (active.some((entry) => entry.column === column)) {
      column += 1;
    }

    const layout: PositionedEvent = {
      event,
      topPercent: (minutesSinceStartOfDay(new Date(start)) / (24 * 60)) * 100,
      heightPercent: Math.max(
        ((end - start) / (24 * 60 * 60 * 1000)) * 100,
        (30 / (24 * 60)) * 100
      ),
      leftPercent: 0,
      widthPercent: 100
    };

    active.push({ layout, end, column });
    const concurrentColumns = Math.max(...active.map((entry) => entry.column)) + 1;
    for (const activeEntry of active) {
      activeEntry.layout.leftPercent = (activeEntry.column / concurrentColumns) * 100;
      activeEntry.layout.widthPercent = 100 / concurrentColumns;
    }

    layouts.push(layout);
  }

  return layouts;
}

export function CalendarTimeGrid({
  mode,
  anchorDate,
  events,
  selectedEventId,
  onSelectDate,
  onSelectEvent
}: CalendarTimeGridProps) {
  const days =
    mode === "day"
      ? [startOfDay(anchorDate)]
      : Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchorDate), index));

  return (
    <section className="meeting-calendar-panel">
      <div className="meeting-time-grid-header">
        <div className="meeting-time-grid-gutter" />
        {days.map((day) => (
          <button
            key={day.toISOString()}
            type="button"
            className="meeting-time-grid-day"
            onClick={() => onSelectDate(day)}
          >
            <span>{day.toLocaleDateString([], { weekday: "short" })}</span>
            <strong>{day.toLocaleDateString([], { month: "short", day: "numeric" })}</strong>
          </button>
        ))}
      </div>

      <div className="meeting-time-grid-all-day">
        <div className="meeting-time-grid-gutter muted">All day</div>
        {days.map((day) => {
          const dayStart = startOfDay(day);
          const dayEnd = endOfDay(day);
          const dayAllDayEvents = events.filter((event) => event.allDay && touchesDay(event, dayStart, dayEnd));

          return (
            <div key={day.toISOString()} className="meeting-time-grid-all-day-column">
              {dayAllDayEvents.map((event) => (
                <button
                  key={event.instanceId}
                  type="button"
                  className={[
                    "meeting-calendar-event-pill",
                    "all-day",
                    event.instanceId === selectedEventId ? "selected" : ""
                  ].join(" ").trim()}
                  onClick={() => onSelectEvent(event)}
                >
                  {event.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div className="meeting-time-grid-body">
        <div className="meeting-time-grid-hours">
          {hourLabels.map((label) => (
            <div key={label} className="meeting-time-grid-hour-label">
              {label}
            </div>
          ))}
        </div>

        {days.map((day) => {
          const dayStart = startOfDay(day);
          const dayEnd = endOfDay(day);
          const dayTimedEvents = events.filter((event) => !event.allDay && touchesDay(event, dayStart, dayEnd));
          const layouts = layoutDayEvents(dayTimedEvents, dayStart, dayEnd);

          return (
            <div key={day.toISOString()} className="meeting-time-grid-column">
              {hourLabels.map((label) => (
                <div key={label} className="meeting-time-grid-hour-slot" />
              ))}

              {layouts.map((layout) => (
                <button
                  key={layout.event.instanceId}
                  type="button"
                  className={[
                    "meeting-time-grid-event",
                    layout.event.instanceId === selectedEventId ? "selected" : ""
                  ].join(" ").trim()}
                  style={{
                    top: `${layout.topPercent}%`,
                    height: `${layout.heightPercent}%`,
                    left: `${layout.leftPercent}%`,
                    width: `${layout.widthPercent}%`
                  }}
                  onClick={() => onSelectEvent(layout.event)}
                >
                  <strong>{layout.event.title}</strong>
                  <span>
                    {new Date(layout.event.occurrenceStartAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                    {" - "}
                    {new Date(layout.event.occurrenceEndAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
