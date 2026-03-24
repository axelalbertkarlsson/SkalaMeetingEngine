import type { CalendarEventOccurrence } from "../../models/calendar";

interface CalendarAgendaProps {
  events: CalendarEventOccurrence[];
  selectedEventId?: string | null;
  onSelectEvent: (event: CalendarEventOccurrence) => void;
}

export function CalendarAgenda({ events, selectedEventId, onSelectEvent }: CalendarAgendaProps) {
  return (
    <section className="meeting-calendar-side-panel">
      <div className="meeting-calendar-side-panel-header">
        <h3 className="block-title">Upcoming</h3>
        <p className="muted">Next meetings from your loaded ICS sources.</p>
      </div>

      <div className="meeting-calendar-agenda-list">
        {events.length === 0 ? (
          <p className="muted">No upcoming meetings in the current range.</p>
        ) : (
          events.map((event) => (
            <button
              key={event.instanceId}
              type="button"
              className={[
                "meeting-calendar-agenda-card",
                event.instanceId === selectedEventId ? "selected" : ""
              ].join(" ").trim()}
              onClick={() => onSelectEvent(event)}
            >
              <span className="meeting-calendar-agenda-date">
                {new Date(event.occurrenceStartAt).toLocaleDateString([], {
                  weekday: "short",
                  month: "short",
                  day: "numeric"
                })}
              </span>
              <strong>{event.title}</strong>
              <span className="muted">
                {event.allDay
                  ? "All day"
                  : `${new Date(event.occurrenceStartAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit"
                    })} - ${new Date(event.occurrenceEndAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit"
                    })}`}
              </span>
              {event.location ? <span className="muted">{event.location}</span> : null}
            </button>
          ))
        )}
      </div>
    </section>
  );
}
