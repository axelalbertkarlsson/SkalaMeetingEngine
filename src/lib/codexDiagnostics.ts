export type CodexDiagnosticLevel = "info" | "warn" | "error";

export interface CodexDiagnosticEntry {
  id: string;
  timestamp: string;
  level: CodexDiagnosticLevel;
  scope: string;
  message: string;
  details: unknown | null;
}

export interface CodexDiagnosticActivity {
  id: string;
  timestamp: string;
  scope: string;
  message: string;
  details: unknown | null;
}

interface CodexDiagnosticsDebugHandle {
  read: () => CodexDiagnosticEntry[];
  clear: () => void;
  readActive: () => CodexDiagnosticActivity | null;
  recoverInterrupted: () => CodexDiagnosticEntry | null;
}

const CODEX_DIAGNOSTICS_STORAGE_KEY = "skala.codex.diagnostics.v1";
const CODEX_DIAGNOSTICS_ACTIVE_STORAGE_KEY = "skala.codex.diagnostics.active.v1";
const MAX_CODEX_DIAGNOSTIC_ENTRIES = 200;
const MAX_SUMMARY_DEPTH = 4;
const MAX_SUMMARY_ARRAY_ITEMS = 8;
const MAX_SUMMARY_OBJECT_KEYS = 12;
const MAX_SUMMARY_STRING_LENGTH = 280;

declare global {
  interface Window {
    __CODEX_DIAGNOSTICS__?: CodexDiagnosticsDebugHandle;
  }
}

function createDiagnosticId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getDiagnosticsStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseStoredJson<T>(key: string, fallback: T) {
  const storage = getDiagnosticsStorage();
  if (!storage) {
    return fallback;
  }

  try {
    const rawValue = storage.getItem(key);
    if (!rawValue) {
      return fallback;
    }

    return JSON.parse(rawValue) as T;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key: string, value: unknown) {
  const storage = getDiagnosticsStorage();
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeStoredValue(key: string) {
  const storage = getDiagnosticsStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage cleanup failures and keep the app responsive.
  }
}

export function summarizeCodexDiagnosticValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (
    value === null
    || value === undefined
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    if (value.length <= MAX_SUMMARY_STRING_LENGTH) {
      return value;
    }

    return {
      kind: "string",
      length: value.length,
      preview: `${value.slice(0, MAX_SUMMARY_STRING_LENGTH).trimEnd()}...`
    };
  }

  if (typeof value === "function") {
    return {
      kind: "function",
      name: value.name || null
    };
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= MAX_SUMMARY_DEPTH) {
    if (Array.isArray(value)) {
      return {
        kind: "array",
        length: value.length
      };
    }

    return {
      kind: "object",
      keys: Object.keys(value as Record<string, unknown>).slice(0, MAX_SUMMARY_OBJECT_KEYS)
    };
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      items: value
        .slice(0, MAX_SUMMARY_ARRAY_ITEMS)
        .map((entry) => summarizeCodexDiagnosticValue(entry, depth + 1, seen))
    };
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "kind",
    "method",
    "phase",
    "request_id",
    "connection_id",
    "id",
    "type",
    "status",
    "itemId",
    "turnId",
    "path",
    "title",
    "message"
  ];
  const keys = Array.from(
    new Set([
      ...preferredKeys.filter((key) => key in record),
      ...Object.keys(record).slice(0, MAX_SUMMARY_OBJECT_KEYS)
    ])
  ).slice(0, MAX_SUMMARY_OBJECT_KEYS);

  const summary: Record<string, unknown> = {};
  keys.forEach((key) => {
    summary[key] = summarizeCodexDiagnosticValue(record[key], depth + 1, seen);
  });

  return summary;
}

export function readCodexDiagnosticEntries() {
  const parsed = parseStoredJson<unknown>(CODEX_DIAGNOSTICS_STORAGE_KEY, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is CodexDiagnosticEntry => {
    return Boolean(entry) && typeof entry === "object";
  });
}

export function clearCodexDiagnosticEntries() {
  removeStoredValue(CODEX_DIAGNOSTICS_STORAGE_KEY);
}

export function appendCodexDiagnosticLog(input: {
  level?: CodexDiagnosticLevel;
  scope: string;
  message: string;
  details?: unknown | null;
}) {
  const nextEntry: CodexDiagnosticEntry = {
    id: createDiagnosticId("codex-log"),
    timestamp: new Date().toISOString(),
    level: input.level ?? "info",
    scope: input.scope,
    message: input.message,
    details:
      input.details === undefined ? null : summarizeCodexDiagnosticValue(input.details)
  };

  const existing = readCodexDiagnosticEntries();
  const nextEntries = [...existing, nextEntry].slice(-MAX_CODEX_DIAGNOSTIC_ENTRIES);
  writeStoredJson(CODEX_DIAGNOSTICS_STORAGE_KEY, nextEntries);
  return nextEntry;
}

export function readCodexDiagnosticActiveActivity() {
  const activity = parseStoredJson<unknown>(CODEX_DIAGNOSTICS_ACTIVE_STORAGE_KEY, null);
  if (!activity || typeof activity !== "object") {
    return null;
  }

  return activity as CodexDiagnosticActivity;
}

export function beginCodexDiagnosticActivity(
  scope: string,
  message: string,
  details?: unknown | null
) {
  const activity: CodexDiagnosticActivity = {
    id: createDiagnosticId("codex-active"),
    timestamp: new Date().toISOString(),
    scope,
    message,
    details:
      details === undefined ? null : summarizeCodexDiagnosticValue(details)
  };

  writeStoredJson(CODEX_DIAGNOSTICS_ACTIVE_STORAGE_KEY, activity);
  return activity.id;
}

export function endCodexDiagnosticActivity(activityId: string) {
  const activeActivity = readCodexDiagnosticActiveActivity();
  if (activeActivity?.id !== activityId) {
    return;
  }

  removeStoredValue(CODEX_DIAGNOSTICS_ACTIVE_STORAGE_KEY);
}

export function recoverInterruptedCodexDiagnosticActivity() {
  const activeActivity = readCodexDiagnosticActiveActivity();
  if (!activeActivity) {
    return null;
  }

  removeStoredValue(CODEX_DIAGNOSTICS_ACTIVE_STORAGE_KEY);
  return appendCodexDiagnosticLog({
    level: "warn",
    scope: "codex.diagnostics",
    message: "Recovered interrupted Codex diagnostic activity from a previous renderer session.",
    details: activeActivity
  });
}

export function installCodexDiagnosticsDebugHandle() {
  if (typeof window === "undefined") {
    return;
  }

  window.__CODEX_DIAGNOSTICS__ = {
    read: readCodexDiagnosticEntries,
    clear: clearCodexDiagnosticEntries,
    readActive: readCodexDiagnosticActiveActivity,
    recoverInterrupted: recoverInterruptedCodexDiagnosticActivity
  };
}
