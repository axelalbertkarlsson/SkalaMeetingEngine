import type { CalendarSourceSnapshot } from "../models/calendar";

export const sampleCalendarSnapshots: CalendarSourceSnapshot[] = [
  {
    source: {
      id: "sample-ics-source",
      workspaceId: "sample-workspace",
      workspaceRoot: "sample",
      provider: "ics",
      kind: "ics_import",
      name: "Sample ICS Calendar",
      fileName: "sample.ics",
      storedPath: "sample.ics",
      createdAt: "2026-03-01T09:00:00Z",
      lastSyncedAt: "2026-03-24T08:00:00Z"
    },
    fetchedAt: "2026-03-24T08:00:00Z",
    stale: false,
    content: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Skala Meeting Engine//Sample Calendar//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:sample-team-sync
DTSTAMP:20260324T070000Z
DTSTART;TZID=Europe/Stockholm:20260324T090000
DTEND;TZID=Europe/Stockholm:20260324T100000
SUMMARY:Weekly product sync
DESCRIPTION:Agenda\\n- Pipeline updates\\n- Release review\\nJoin: https://meet.example.com/team-sync
LOCATION:Studio B
ORGANIZER;CN=Axel Karlsson:mailto:axel@example.com
ATTENDEE;CN=Sara;PARTSTAT=ACCEPTED:mailto:sara@example.com
ATTENDEE;CN=Jonas;PARTSTAT=TENTATIVE:mailto:jonas@example.com
RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10
END:VEVENT
BEGIN:VEVENT
UID:sample-design-review
DTSTAMP:20260324T070000Z
DTSTART;TZID=Europe/Stockholm:20260325T130000
DTEND;TZID=Europe/Stockholm:20260325T140000
SUMMARY:Design review
DESCRIPTION:Review the meetings calendar shell.
LOCATION:https://meet.example.com/design-review
ORGANIZER;CN=Product:mailto:product@example.com
END:VEVENT
BEGIN:VEVENT
UID:sample-board-prep
DTSTAMP:20260324T070000Z
DTSTART;VALUE=DATE:20260331
DTEND;VALUE=DATE:20260401
SUMMARY:Board prep day
DESCRIPTION:All-day prep before the offsite.
END:VEVENT
END:VCALENDAR`
  }
];
