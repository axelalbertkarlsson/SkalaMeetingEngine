export type CalendarProviderId = "ics";
export type CalendarSourceKind = "ics_import" | "ics_subscription";
export type CalendarViewMode = "month" | "week" | "day";

export interface CalendarSource {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  provider: CalendarProviderId;
  kind: CalendarSourceKind;
  name: string;
  url?: string;
  fileName?: string;
  storedPath: string;
  createdAt: string;
  lastSyncedAt?: string;
  lastSyncError?: string;
}

export interface CalendarSourceSnapshot {
  source: CalendarSource;
  content: string | null;
  fetchedAt: string;
  stale: boolean;
  error?: string;
}

export interface CalendarParticipant {
  name?: string;
  email?: string;
  role?: string;
  status?: string;
}

export interface CalendarOrganizer {
  name?: string;
  email?: string;
}

export interface CalendarRecurrence {
  rule?: string;
  frequency?: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  count?: number;
  until?: string;
  byDay?: string[];
  byMonthDay?: number[];
  exDates?: string[];
}

export interface CalendarEventSourceInfo {
  provider: CalendarProviderId;
  sourceId: string;
  sourceKind: CalendarSourceKind;
  sourceName: string;
}

export interface CalendarEvent {
  id: string;
  source: CalendarEventSourceInfo;
  externalId: string;
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  location?: string;
  joinUrl?: string;
  organizer?: CalendarOrganizer;
  attendees: CalendarParticipant[];
  recurrence?: CalendarRecurrence;
  status?: string;
  raw?: Record<string, unknown>;
}

export interface CalendarEventOccurrence extends CalendarEvent {
  instanceId: string;
  seriesMasterId: string;
  occurrenceStartAt: string;
  occurrenceEndAt: string;
  occurrenceDateKey: string;
  occurrenceEndDateKey: string;
  isRecurringInstance: boolean;
}

export interface CalendarLoadRange {
  startAt: string;
  endAt: string;
}

export interface CalendarDataSnapshot {
  sources: CalendarSourceSnapshot[];
  events: CalendarEventOccurrence[];
  range: CalendarLoadRange;
  generatedAt: string;
}
