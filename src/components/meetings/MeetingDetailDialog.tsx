import type { CalendarEventOccurrence } from "../../models/calendar";

interface MeetingDetailDialogProps {
  event: CalendarEventOccurrence | null;
  onClose: () => void;
}

export function MeetingDetailDialog({ event, onClose }: MeetingDetailDialogProps) {
  if (!event) {
    return null;
  }

  return (
    <div className="meeting-detail-dialog-overlay" role="presentation" onClick={onClose}>
      <section
        className="meeting-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meeting-detail-title"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="meeting-detail-dialog-header">
          <div>
            <p className="pane-eyebrow">Meeting</p>
            <h2 id="meeting-detail-title" className="pane-title">
              {event.title}
            </h2>
            <p className="pane-subtitle">{event.source.sourceName}</p>
          </div>
          <button type="button" className="meeting-detail-close" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="meeting-detail-dialog-grid">
          <article className="meeting-detail-card">
            <h3 className="block-title">Schedule</h3>
            <dl className="meeting-detail-list">
              <div>
                <dt>Date</dt>
                <dd>{new Date(event.occurrenceStartAt).toLocaleDateString()}</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>
                  {event.allDay
                    ? "All day"
                    : `${new Date(event.occurrenceStartAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit"
                      })} - ${new Date(event.occurrenceEndAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit"
                      })}`}
                </dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{event.timezone}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{event.status ?? "confirmed"}</dd>
              </div>
            </dl>
          </article>

          <article className="meeting-detail-card">
            <h3 className="block-title">Context</h3>
            <dl className="meeting-detail-list">
              <div>
                <dt>Location</dt>
                <dd>{event.location ?? "Not provided"}</dd>
              </div>
              <div>
                <dt>Join link</dt>
                <dd>
                  {event.joinUrl ? (
                    <a href={event.joinUrl} target="_blank" rel="noreferrer">
                      {event.joinUrl}
                    </a>
                  ) : (
                    "Not provided"
                  )}
                </dd>
              </div>
              <div>
                <dt>Organizer</dt>
                <dd>{event.organizer?.name ?? event.organizer?.email ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Attendees</dt>
                <dd>
                  {event.attendees.length > 0
                    ? event.attendees
                        .map((attendee) => attendee.name ?? attendee.email ?? "Unknown attendee")
                        .join(", ")
                    : "Not provided"}
                </dd>
              </div>
            </dl>
          </article>
        </div>

        <article className="meeting-detail-card">
          <h3 className="block-title">Notes</h3>
          <pre className="meeting-detail-description">{event.description ?? "No description or notes were provided in the calendar entry."}</pre>
        </article>
      </section>
    </div>
  );
}
