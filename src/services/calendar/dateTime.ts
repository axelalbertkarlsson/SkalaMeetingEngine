export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const timeZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function getTimeZoneFormatter(timeZone: string) {
  const safeTimeZone = normalizeTimeZone(timeZone);
  const cached = timeZoneFormatters.get(safeTimeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  timeZoneFormatters.set(safeTimeZone, formatter);
  return formatter;
}

function getTimeZoneParts(date: Date, timeZone: string) {
  const parts = getTimeZoneFormatter(timeZone).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second)
  };
}

export function getLocalPartsInTimeZone(date: Date, timeZone: string): LocalDateTimeParts {
  return getTimeZoneParts(date, timeZone);
}

function getTimeZoneOffsetMilliseconds(date: Date, timeZone: string) {
  const parts = getTimeZoneParts(date, timeZone);
  const reconstructedUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return reconstructedUtc - date.getTime();
}

export function normalizeTimeZone(timeZone?: string) {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!timeZone) {
    return fallback;
  }

  try {
    getTimeZoneFormatter(timeZone);
    return timeZone;
  } catch {
    return fallback;
  }
}

export function getUserTimeZone() {
  return normalizeTimeZone();
}

export function zonedLocalPartsToDate(parts: LocalDateTimeParts, timeZone: string) {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const initialUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  let adjustedUtc = initialUtc - getTimeZoneOffsetMilliseconds(new Date(initialUtc), normalizedTimeZone);
  const secondPassOffset = getTimeZoneOffsetMilliseconds(new Date(adjustedUtc), normalizedTimeZone);
  adjustedUtc = initialUtc - secondPassOffset;

  return new Date(adjustedUtc);
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

export function addYears(date: Date, years: number) {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

export function addDaysToLocalParts(parts: LocalDateTimeParts, days: number): LocalDateTimeParts {
  const next = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second)
  );

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: next.getUTCHours(),
    minute: next.getUTCMinutes(),
    second: next.getUTCSeconds()
  };
}

export function addMonthsToLocalParts(parts: LocalDateTimeParts, months: number): LocalDateTimeParts {
  const next = new Date(
    Date.UTC(parts.year, parts.month - 1 + months, parts.day, parts.hour, parts.minute, parts.second)
  );

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: next.getUTCHours(),
    minute: next.getUTCMinutes(),
    second: next.getUTCSeconds()
  };
}

export function addYearsToLocalParts(parts: LocalDateTimeParts, years: number): LocalDateTimeParts {
  const next = new Date(
    Date.UTC(parts.year + years, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  );

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: next.getUTCHours(),
    minute: next.getUTCMinutes(),
    second: next.getUTCSeconds()
  };
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

export function startOfWeek(date: Date) {
  const day = date.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  return startOfDay(addDays(date, offset));
}

export function endOfWeek(date: Date) {
  return endOfDay(addDays(startOfWeek(date), 6));
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

export function getMonthGridStart(date: Date) {
  return startOfWeek(startOfMonth(date));
}

export function getMonthGridEnd(date: Date) {
  return endOfWeek(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

export function getDateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

export function getDateKeyInTimeZone(date: Date, timeZone: string) {
  const parts = getTimeZoneParts(date, timeZone);
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}

export function parseDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function getLocalWeekdayCode(parts: Pick<LocalDateTimeParts, "year" | "month" | "day">) {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][day];
}

export function compareLocalParts(left: LocalDateTimeParts, right: LocalDateTimeParts) {
  return (
    Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute, left.second) -
    Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute, right.second)
  );
}

export function minutesSinceStartOfDay(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function isSameDay(left: Date, right: Date) {
  return getDateKey(left) === getDateKey(right);
}
