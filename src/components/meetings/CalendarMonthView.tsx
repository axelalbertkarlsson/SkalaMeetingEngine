import type { CalendarEventOccurrence } from "../../models/calendar";
import { addDays, getDateKey, getMonthGridEnd, getMonthGridStart, isSameDay } from "../../services/calendar/dateTime";

interface CalendarMonthViewProps {
  anchorDate: Date;
  selectedDate: Date;
  events: CalendarEventOccurrence[];
  selectedEventId?: string | null;
  onSelectDate: (date: Date) => void;
  onSelectEvent: (event: CalendarEventOccurrence) => void;
}

const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function isOccurrenceOnDate(event: CalendarEventOccurrence, dateKey: string) {
  if (event.allDay) {
    return dateKey >= event.occurrenceDateKey && dateKey < event.occurrenceEndDateKey;
  }

  return dateKey >= event.occurrenceDateKey && dateKey <= event.occurrenceEndDateKey;
}

export function CalendarMonthView({
  anchorDate,
  selectedDate,
  events,
  selectedEventId,
  onSelectDate,
  onSelectEvent
}: CalendarMonthViewProps) {
  const gridStart = getMonthGridStart(anchorDate);
  const gridEnd = getMonthGridEnd(anchorDate);
  const dayCells: Date[] = [];

  for (let cursor = gridStart; cursor < gridEnd; cursor = addDays(cursor, 1)) {
    dayCells.push(cursor);
  }

  return (
    <section className="meeting-calendar-panel">
      <div className="meeting-calendar-month-header">
        {weekdayLabels.map((label) => (
          <div key={label} className="meeting-calendar-month-weekday">
            {label}
          </div>
        ))}
      </div>

      <div className="meeting-calendar-month-grid">
        {dayCells.map((day) => {
          const dateKey = getDateKey(day);
          const dayEvents = events.filter((event) => isOccurrenceOnDate(event, dateKey));
          const visibleEvents = dayEvents.slice(0, 4);
          const overflowCount = Math.max(0, dayEvents.length - visibleEvents.length);
          const isOutsideMonth = day.getMonth() !== anchorDate.getMonth();

          return (
            <button
              key={dateKey}
              type="button"
              className={[
                "meeting-calendar-day-cell",
                isOutsideMonth ? "outside" : "",
                isSameDay(day, selectedDate) ? "selected" : ""
              ].join(" ").trim()}
              onClick={() => onSelectDate(day)}
            >
              <span className="meeting-calendar-day-label">{day.getDate()}</span>
              <div className="meeting-calendar-day-events">
                {visibleEvents.map((event) => (
                  <button
                    key={event.instanceId}
                    type="button"
                    className={[
                      "meeting-calendar-event-pill",
                      event.instanceId === selectedEventId ? "selected" : "",
                      event.allDay ? "all-day" : ""
                    ].join(" ").trim()}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      onSelectEvent(event);
                    }}
                  >
                    <span className="meeting-calendar-event-pill-time">
                      {event.allDay
                        ? "All day"
                        : new Date(event.occurrenceStartAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit"
                          })}
                    </span>
                    <span className="meeting-calendar-event-pill-title">{event.title}</span>
                  </button>
                ))}
                {overflowCount > 0 ? (
                  <span className="meeting-calendar-day-more">+{overflowCount} more</span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
