import type {
  CalendarEventOccurrence,
  CalendarLoadRange,
  CalendarOrganizer,
  CalendarParticipant,
  CalendarRecurrence,
  CalendarSourceSnapshot
} from "../../models/calendar";
import {
  addDaysToLocalParts,
  addMonthsToLocalParts,
  addYearsToLocalParts,
  compareLocalParts,
  getDateKey,
  getDateKeyInTimeZone,
  getLocalWeekdayCode,
  getUserTimeZone,
  normalizeTimeZone,
  zonedLocalPartsToDate,
  type LocalDateTimeParts
} from "./dateTime";

interface IcsProperty {
  name: string;
  params: Record<string, string[]>;
  value: string;
}

interface ParsedDateValue {
  iso: string;
  date: Date;
  timezone: string;
  allDay: boolean;
  localParts: LocalDateTimeParts;
  localKey: string;
}

interface ParsedRecurrenceRule {
  raw: string;
  frequency?: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  count?: number;
  until?: ParsedDateValue;
  byDay?: string[];
  byMonthDay?: number[];
  exDates: Set<string>;
}

interface ParsedEvent {
  uid: string;
  externalId: string;
  title: string;
  description?: string;
  start: ParsedDateValue;
  end: ParsedDateValue;
  durationMs: number;
  allDay: boolean;
  timezone: string;
  location?: string;
  joinUrl?: string;
  organizer?: CalendarOrganizer;
  attendees: CalendarParticipant[];
  recurrence?: ParsedRecurrenceRule;
  recurrenceId?: ParsedDateValue;
  status?: string;
  raw: Record<string, unknown>;
  source: CalendarSourceSnapshot["source"];
}

const weekdayOrder = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

export function buildEventsFromIcsSnapshot(
  snapshot: CalendarSourceSnapshot,
  range: CalendarLoadRange
): CalendarEventOccurrence[] {
  if (!snapshot.content?.trim()) {
    return [];
  }

  const parsedEvents = parseIcsEvents(snapshot);
  const overrides = new Map<string, ParsedEvent>();
  const consumedOverrides = new Set<string>();

  for (const event of parsedEvents) {
    if (event.recurrenceId) {
      overrides.set(`${event.uid}:${event.recurrenceId.localKey}`, event);
    }
  }

  const results: CalendarEventOccurrence[] = [];

  for (const event of parsedEvents) {
    if (event.recurrenceId) {
      continue;
    }

    if (event.recurrence) {
      results.push(...expandRecurringEvent(event, range, overrides, consumedOverrides));
      continue;
    }

    if (occurrenceOverlapsRange(event.start.date, event.end.date, range)) {
      results.push(createOccurrence(event, event.start.date, event.end.date, event.start.localKey, false));
    }
  }

  for (const [overrideKey, override] of overrides.entries()) {
    if (consumedOverrides.has(overrideKey)) {
      continue;
    }

    if (occurrenceOverlapsRange(override.start.date, override.end.date, range)) {
      results.push(
        createOccurrence(
          override,
          override.start.date,
          override.end.date,
          override.recurrenceId?.localKey ?? override.start.localKey,
          false
        )
      );
    }
  }

  return results.sort((left, right) => {
    const startDiff =
      new Date(left.occurrenceStartAt).getTime() - new Date(right.occurrenceStartAt).getTime();
    if (startDiff !== 0) {
      return startDiff;
    }

    return left.title.localeCompare(right.title);
  });
}

function parseIcsEvents(snapshot: CalendarSourceSnapshot) {
  const lines = unfoldLines(snapshot.content ?? "");
  const events: ParsedEvent[] = [];
  let currentProperties: IcsProperty[] | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      currentProperties = [];
      continue;
    }

    if (line === "END:VEVENT") {
      if (currentProperties) {
        const parsed = parseEvent(snapshot, currentProperties);
        if (parsed) {
          events.push(parsed);
        }
      }
      currentProperties = null;
      continue;
    }

    if (currentProperties) {
      currentProperties.push(parsePropertyLine(line));
    }
  }

  return events;
}

function unfoldLines(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .reduce<string[]>((lines, line) => {
      if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
        lines[lines.length - 1] += line.slice(1);
      } else if (line.length > 0) {
        lines.push(line);
      }

      return lines;
    }, []);
}

function parsePropertyLine(line: string): IcsProperty {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return {
      name: line.toUpperCase(),
      params: {},
      value: ""
    };
  }

  const left = line.slice(0, separatorIndex);
  const value = line.slice(separatorIndex + 1);
  const parts = left.split(";");
  const name = parts[0].toUpperCase();
  const params: Record<string, string[]> = {};

  for (const rawParam of parts.slice(1)) {
    const [rawKey, rawValue = ""] = rawParam.split("=");
    const key = rawKey.toUpperCase();
    const cleanedValue = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
    params[key] = cleanedValue.split(",").filter(Boolean);
  }

  return { name, params, value };
}

function parseEvent(snapshot: CalendarSourceSnapshot, properties: IcsProperty[]): ParsedEvent | null {
  const propertyMap = new Map<string, IcsProperty[]>();
  for (const property of properties) {
    const bucket = propertyMap.get(property.name) ?? [];
    bucket.push(property);
    propertyMap.set(property.name, bucket);
  }

  const timeZone = normalizeTimeZone(firstParam(propertyMap, "DTSTART", "TZID") ?? getUserTimeZone());
  const startProperty = firstProperty(propertyMap, "DTSTART");
  if (!startProperty) {
    return null;
  }

  const start = parseDateValue(startProperty.value, startProperty.params, timeZone);
  const endProperty = firstProperty(propertyMap, "DTEND");
  const durationMs = parseDurationToMilliseconds(firstPropertyValue(propertyMap, "DURATION"));
  const end = endProperty
    ? parseDateValue(endProperty.value, endProperty.params, timeZone)
    : createSyntheticEnd(start, durationMs);
  const description = firstPropertyValue(propertyMap, "DESCRIPTION");
  const location = firstPropertyValue(propertyMap, "LOCATION");
  const url = firstPropertyValue(propertyMap, "URL");
  const attendees = (propertyMap.get("ATTENDEE") ?? []).map(parseParticipant).filter(Boolean) as CalendarParticipant[];
  const organizer = parseOrganizer(firstProperty(propertyMap, "ORGANIZER"));
  const recurrence = parseRecurrenceRule(
    firstPropertyValue(propertyMap, "RRULE"),
    propertyMap.get("EXDATE") ?? [],
    timeZone
  );
  const recurrenceIdProperty = firstProperty(propertyMap, "RECURRENCE-ID");
  const recurrenceId = recurrenceIdProperty
    ? parseDateValue(recurrenceIdProperty.value, recurrenceIdProperty.params, timeZone)
    : undefined;

  return {
    uid: firstPropertyValue(propertyMap, "UID") ?? `${snapshot.source.id}:${start.localKey}`,
    externalId: firstPropertyValue(propertyMap, "UID") ?? `${snapshot.source.id}:${start.localKey}`,
    title: unescapeText(firstPropertyValue(propertyMap, "SUMMARY")) || "Untitled meeting",
    description: unescapeText(description),
    start,
    end,
    durationMs: Math.max(end.date.getTime() - start.date.getTime(), 15 * 60 * 1000),
    allDay: start.allDay,
    timezone: start.timezone,
    location: unescapeText(location),
    joinUrl: extractJoinUrl(url, location, description),
    organizer: organizer ?? undefined,
    attendees,
    recurrence,
    recurrenceId,
    status: firstPropertyValue(propertyMap, "STATUS")?.toLowerCase(),
    raw: {
      description,
      location,
      url,
      sourceStoredPath: snapshot.source.storedPath
    },
    source: snapshot.source
  };
}

function firstProperty(propertyMap: Map<string, IcsProperty[]>, name: string) {
  return propertyMap.get(name)?.[0];
}

function firstPropertyValue(propertyMap: Map<string, IcsProperty[]>, name: string) {
  return propertyMap.get(name)?.[0]?.value;
}

function firstParam(
  propertyMap: Map<string, IcsProperty[]>,
  propertyName: string,
  paramName: string
) {
  return propertyMap.get(propertyName)?.[0]?.params[paramName]?.[0];
}

function unescapeText(value?: string) {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseDateValue(
  value: string,
  params: Record<string, string[]>,
  defaultTimeZone: string
): ParsedDateValue {
  const isDateOnly = params.VALUE?.includes("DATE") || /^\d{8}$/.test(value);
  const timeZone = normalizeTimeZone(params.TZID?.[0] ?? (value.endsWith("Z") ? "UTC" : defaultTimeZone));

  if (isDateOnly) {
    const localParts = {
      year: Number(value.slice(0, 4)),
      month: Number(value.slice(4, 6)),
      day: Number(value.slice(6, 8)),
      hour: 0,
      minute: 0,
      second: 0
    };
    const date = zonedLocalPartsToDate(localParts, timeZone);
    return {
      iso: date.toISOString(),
      date,
      timezone: timeZone,
      allDay: true,
      localParts,
      localKey: formatLocalKey(localParts, true)
    };
  }

  const trimmed = value.endsWith("Z") ? value.slice(0, -1) : value;
  const localParts = {
    year: Number(trimmed.slice(0, 4)),
    month: Number(trimmed.slice(4, 6)),
    day: Number(trimmed.slice(6, 8)),
    hour: Number(trimmed.slice(9, 11)),
    minute: Number(trimmed.slice(11, 13)),
    second: Number(trimmed.slice(13, 15) || "0")
  };

  if (value.endsWith("Z")) {
    const date = new Date(
      Date.UTC(
        localParts.year,
        localParts.month - 1,
        localParts.day,
        localParts.hour,
        localParts.minute,
        localParts.second
      )
    );
    return {
      iso: date.toISOString(),
      date,
      timezone: "UTC",
      allDay: false,
      localParts,
      localKey: formatLocalKey(localParts, false)
    };
  }

  const date = zonedLocalPartsToDate(localParts, timeZone);
  return {
    iso: date.toISOString(),
    date,
    timezone: timeZone,
    allDay: false,
    localParts,
    localKey: formatLocalKey(localParts, false)
  };
}

function createSyntheticEnd(start: ParsedDateValue, durationMs?: number) {
  const effectiveDurationMs = durationMs ?? (start.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
  const date = new Date(start.date.getTime() + effectiveDurationMs);
  const localParts = start.allDay
    ? addDaysToLocalParts(start.localParts, 1)
    : {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds()
      };

  return {
    iso: date.toISOString(),
    date,
    timezone: start.timezone,
    allDay: start.allDay,
    localParts,
    localKey: formatLocalKey(localParts, start.allDay)
  };
}

function parseDurationToMilliseconds(duration?: string) {
  if (!duration) {
    return undefined;
  }

  const match = duration.match(
    /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/
  );
  if (!match?.groups) {
    return undefined;
  }

  const days = Number(match.groups.days ?? 0);
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes ?? 0);
  const seconds = Number(match.groups.seconds ?? 0);

  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function parseOrganizer(property?: IcsProperty): CalendarOrganizer | null {
  if (!property) {
    return null;
  }

  return {
    name: property.params.CN?.[0],
    email: normalizeCalendarAddress(property.value)
  };
}

function parseParticipant(property: IcsProperty): CalendarParticipant | null {
  const email = normalizeCalendarAddress(property.value);
  if (!email && !property.params.CN?.[0]) {
    return null;
  }

  return {
    name: property.params.CN?.[0],
    email,
    role: property.params.ROLE?.[0]?.toLowerCase(),
    status: property.params.PARTSTAT?.[0]?.toLowerCase()
  };
}

function normalizeCalendarAddress(value: string) {
  return value.replace(/^mailto:/i, "").trim() || undefined;
}

function extractJoinUrl(...values: Array<string | undefined>) {
  const combined = values.filter(Boolean).join("\n");
  const match = combined.match(/https?:\/\/[^\s<>"]+/i);
  return match?.[0];
}

function parseRecurrenceRule(
  value: string | undefined,
  exDateProperties: IcsProperty[],
  timeZone: string
): ParsedRecurrenceRule | undefined {
  if (!value) {
    return undefined;
  }

  const pairs = Object.fromEntries(
    value.split(";").map((segment) => {
      const [key, rawValue = ""] = segment.split("=");
      return [key.toUpperCase(), rawValue];
    })
  );
  const frequencyMap: Record<string, ParsedRecurrenceRule["frequency"]> = {
    DAILY: "daily",
    WEEKLY: "weekly",
    MONTHLY: "monthly",
    YEARLY: "yearly"
  };
  const exDates = new Set<string>();

  for (const property of exDateProperties) {
    for (const rawValue of property.value.split(",")) {
      exDates.add(parseDateValue(rawValue, property.params, timeZone).localKey);
    }
  }

  return {
    raw: value,
    frequency: frequencyMap[pairs.FREQ],
    interval: Math.max(1, Number(pairs.INTERVAL ?? "1")),
    count: pairs.COUNT ? Number(pairs.COUNT) : undefined,
    until: pairs.UNTIL ? parseDateValue(pairs.UNTIL, {}, timeZone) : undefined,
    byDay: pairs.BYDAY ? pairs.BYDAY.split(",").filter(Boolean) : undefined,
    byMonthDay: pairs.BYMONTHDAY
      ? pairs.BYMONTHDAY.split(",").map((entry) => Number(entry)).filter((entry) => !Number.isNaN(entry))
      : undefined,
    exDates
  };
}

function expandRecurringEvent(
  event: ParsedEvent,
  range: CalendarLoadRange,
  overrides: Map<string, ParsedEvent>,
  consumedOverrides: Set<string>
) {
  const rule = event.recurrence;
  if (!rule?.frequency) {
    return [];
  }

  const results: CalendarEventOccurrence[] = [];
  const rangeEnd = new Date(range.endAt).getTime();
  const untilTime = rule.until ? new Date(rule.until.iso).getTime() : Number.POSITIVE_INFINITY;
  const maxCount = rule.count ?? Number.POSITIVE_INFINITY;
  let produced = 0;
  const maxIterations = 800;

  const pushOccurrence = (candidateParts: LocalDateTimeParts) => {
    if (produced >= maxCount) {
      return false;
    }

    const localKey = formatLocalKey(candidateParts, event.allDay);
    if (rule.exDates.has(localKey)) {
      return true;
    }

    const overrideKey = `${event.uid}:${localKey}`;
    const override = overrides.get(overrideKey);
    if (override) {
      consumedOverrides.add(overrideKey);
      if (occurrenceOverlapsRange(override.start.date, override.end.date, range)) {
        results.push(
          createOccurrence(
            override,
            override.start.date,
            override.end.date,
            override.recurrenceId?.localKey ?? override.start.localKey,
            true
          )
        );
      }
      produced += 1;
      return true;
    }

    const startDate = zonedLocalPartsToDate(candidateParts, event.timezone);
    if (startDate.getTime() > untilTime) {
      return false;
    }

    if (startDate.getTime() > rangeEnd && produced > 0) {
      return false;
    }

    const endDate = new Date(startDate.getTime() + event.durationMs);
    if (occurrenceOverlapsRange(startDate, endDate, range)) {
      results.push(createOccurrence(event, startDate, endDate, localKey, true));
    }
    produced += 1;
    return true;
  };

  if (rule.frequency === "daily") {
    for (let index = 0; index < maxIterations; index += 1) {
      const candidateParts = addDaysToLocalParts(event.start.localParts, index * rule.interval);
      if (rule.byDay?.length && !rule.byDay.includes(getLocalWeekdayCode(candidateParts))) {
        continue;
      }
      if (!pushOccurrence(candidateParts)) {
        break;
      }
    }
  }

  if (rule.frequency === "weekly") {
    const byDay = [...(rule.byDay?.length ? rule.byDay : [getLocalWeekdayCode(event.start.localParts)])].sort(
      (left, right) => weekdayOrder.indexOf(left) - weekdayOrder.indexOf(right)
    );
    const startWeekOffset = weekdayOrder.indexOf(getLocalWeekdayCode(event.start.localParts));
    const weekStart = addDaysToLocalParts(event.start.localParts, -startWeekOffset);

    for (let index = 0; index < maxIterations; index += 1) {
      const activeWeekStart = addDaysToLocalParts(weekStart, index * rule.interval * 7);
      for (const weekday of byDay) {
        const candidateBase = addDaysToLocalParts(activeWeekStart, weekdayOrder.indexOf(weekday));
        const candidateParts = {
          ...candidateBase,
          hour: event.start.localParts.hour,
          minute: event.start.localParts.minute,
          second: event.start.localParts.second
        };
        if (compareLocalParts(candidateParts, event.start.localParts) < 0) {
          continue;
        }
        if (!pushOccurrence(candidateParts)) {
          return results;
        }
      }
    }
  }

  if (rule.frequency === "monthly") {
    const monthDays = rule.byMonthDay?.length ? rule.byMonthDay : [event.start.localParts.day];
    for (let index = 0; index < maxIterations; index += 1) {
      const monthBase = addMonthsToLocalParts({ ...event.start.localParts, day: 1 }, index * rule.interval);
      for (const monthDay of monthDays) {
        const candidateParts = addDaysToLocalParts({ ...monthBase, hour: event.start.localParts.hour, minute: event.start.localParts.minute, second: event.start.localParts.second }, monthDay - 1);
        if (candidateParts.month !== monthBase.month) {
          continue;
        }
        if (compareLocalParts(candidateParts, event.start.localParts) < 0) {
          continue;
        }
        if (!pushOccurrence(candidateParts)) {
          return results;
        }
      }
    }
  }

  if (rule.frequency === "yearly") {
    for (let index = 0; index < maxIterations; index += 1) {
      const candidateParts = addYearsToLocalParts(event.start.localParts, index * rule.interval);
      if (!pushOccurrence(candidateParts)) {
        break;
      }
    }
  }

  return results;
}

function occurrenceOverlapsRange(startDate: Date, endDate: Date, range: CalendarLoadRange) {
  const rangeStart = new Date(range.startAt).getTime();
  const rangeEnd = new Date(range.endAt).getTime();
  return startDate.getTime() < rangeEnd && endDate.getTime() > rangeStart;
}

function createOccurrence(
  event: ParsedEvent,
  startDate: Date,
  endDate: Date,
  localKey: string,
  isRecurringInstance: boolean
): CalendarEventOccurrence {
  const recurrence: CalendarRecurrence | undefined = event.recurrence
    ? {
        rule: event.recurrence.raw,
        frequency: event.recurrence.frequency,
        interval: event.recurrence.interval,
        count: event.recurrence.count,
        until: event.recurrence.until?.iso,
        byDay: event.recurrence.byDay,
        byMonthDay: event.recurrence.byMonthDay,
        exDates: [...event.recurrence.exDates]
      }
    : undefined;
  const baseId = `${event.source.id}:${event.externalId}`;
  const instanceId = `${baseId}:${localKey}`;

  return {
    id: instanceId,
    instanceId,
    seriesMasterId: baseId,
    source: {
      provider: "ics",
      sourceId: event.source.id,
      sourceKind: event.source.kind,
      sourceName: event.source.name
    },
    externalId: event.externalId,
    title: event.title,
    description: event.description,
    startAt: startDate.toISOString(),
    endAt: endDate.toISOString(),
    occurrenceStartAt: startDate.toISOString(),
    occurrenceEndAt: endDate.toISOString(),
    occurrenceDateKey: event.allDay ? localKey.slice(0, 10) : getDateKey(startDate),
    occurrenceEndDateKey: event.allDay
      ? event.end.localKey.slice(0, 10)
      : getDateKeyInTimeZone(endDate, getUserTimeZone()),
    allDay: event.allDay,
    timezone: event.timezone,
    location: event.location,
    joinUrl: event.joinUrl,
    organizer: event.organizer,
    attendees: event.attendees,
    recurrence,
    status: event.status,
    isRecurringInstance,
    raw: {
      ...event.raw,
      sourceLocalStartKey: localKey
    }
  };
}

function formatLocalKey(parts: LocalDateTimeParts, allDay: boolean) {
  const datePart = [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");

  if (allDay) {
    return datePart;
  }

  return `${datePart}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(
    2,
    "0"
  )}:${String(parts.second).padStart(2, "0")}`;
}
