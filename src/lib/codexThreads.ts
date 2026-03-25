import {
  createCodexConversationEntryFromItem,
  upsertConversationEntry
} from "./codexContext.js";
import type {
  CodexContextItem,
  CodexConversationEntry,
  CodexThreadDetails,
  CodexThreadLocalState,
  CodexThreadLocalStore,
  CodexThreadSummary
} from "../models/codex.js";

export const EMPTY_CODEX_THREAD_LOCAL_STORE: CodexThreadLocalStore = {
  lastOpenedThreadId: null,
  threads: {}
};

export function getCodexThreadLocalStoreKey(workspaceRoot: string) {
  return `codex.threadHistory.${workspaceRoot}`;
}

export function sanitizeCodexThreadLocalStore(value: unknown): CodexThreadLocalStore {
  if (!value || typeof value !== "object") {
    return EMPTY_CODEX_THREAD_LOCAL_STORE;
  }

  const record = value as Record<string, unknown>;
  const rawThreads = record.threads;
  const threads: CodexThreadLocalStore["threads"] = {};

  if (rawThreads && typeof rawThreads === "object") {
    Object.entries(rawThreads as Record<string, unknown>).forEach(([threadId, rawState]) => {
      threads[threadId] = sanitizeCodexThreadLocalState(rawState);
    });
  }

  return {
    lastOpenedThreadId:
      typeof record.lastOpenedThreadId === "string" ? record.lastOpenedThreadId : null,
    threads
  };
}

export function sanitizeCodexThreadLocalState(value: unknown): CodexThreadLocalState {
  if (!value || typeof value !== "object") {
    return createInitialCodexThreadLocalState();
  }

  const record = value as Record<string, unknown>;
  const rawContextItems = Array.isArray(record.contextItems) ? record.contextItems : [];

  return {
    customTitle: typeof record.customTitle === "string" ? record.customTitle : null,
    draft: typeof record.draft === "string" ? record.draft : "",
    contextItems: rawContextItems.filter(isCodexContextItem),
    lastOpenedAt: typeof record.lastOpenedAt === "string" ? record.lastOpenedAt : null,
    lastSubmittedPrompt:
      typeof record.lastSubmittedPrompt === "string" ? record.lastSubmittedPrompt : null
  };
}

export function createInitialCodexThreadLocalState(): CodexThreadLocalState {
  return {
    customTitle: null,
    draft: "",
    contextItems: [],
    lastOpenedAt: null,
    lastSubmittedPrompt: null
  };
}

function isCodexContextItem(value: unknown): value is CodexContextItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string"
    && (record.kind === "document_note" || record.kind === "meeting_artifact")
    && typeof record.label === "string"
    && typeof record.path === "string"
    && typeof record.sourceId === "string"
  );
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function asItemsFromTurn(turn: unknown) {
  const turnRecord = asRecord(turn);
  if (!turnRecord) {
    return [];
  }

  if (Array.isArray(turnRecord.items)) {
    return turnRecord.items;
  }

  const result = asRecord(turnRecord.result);
  if (result && Array.isArray(result.items)) {
    return result.items;
  }

  return [];
}

export function getCodexConversationEntriesFromTurn(rawTurn: unknown) {
  const turnRecord = asRecord(rawTurn);
  const turnId = asString(turnRecord?.id) ?? "";
  const entries: CodexConversationEntry[] = [];

  asItemsFromTurn(rawTurn).forEach((item) => {
    const entry = createCodexConversationEntryFromItem(item, turnId);
    if (!entry) {
      return;
    }

    const nextEntries = upsertConversationEntry(entries, entry);
    entries.splice(0, entries.length, ...nextEntries);
  });

  return entries;
}

function getTurnsFromThread(rawThread: unknown) {
  const thread = asRecord(rawThread);
  if (!thread) {
    return [];
  }

  if (Array.isArray(thread.turns)) {
    return thread.turns;
  }

  const result = asRecord(thread.result);
  if (result && Array.isArray(result.turns)) {
    return result.turns;
  }

  return [];
}

export function getCodexConversationEntriesFromThread(rawThread: unknown) {
  const turns = getTurnsFromThread(rawThread);
  const entries: CodexConversationEntry[] = [];

  turns.forEach((turn) => {
    const nextEntries = getCodexConversationEntriesFromTurn(turn);
    nextEntries.forEach((entry) => {
      const mergedEntries = upsertConversationEntry(entries, entry);
      entries.splice(0, entries.length, ...mergedEntries);
    });
  });

  return entries;
}

export function extractCodexThreadSummary(rawThread: unknown): CodexThreadSummary | null {
  const thread = asRecord(rawThread);
  if (!thread) {
    return null;
  }

  const id = asString(thread.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: asString(thread.name),
    createdAt: asString(thread.createdAt),
    updatedAt: asString(thread.updatedAt),
    status:
      asString(thread.runtimeStatus)
      ?? asString(thread.status)
      ?? asString(asRecord(thread.runtime)?.status),
    preview: getCodexThreadPreviewFromThread(rawThread),
    archived: asBoolean(thread.archived) ?? false
  };
}

export function extractCodexThreadDetails(rawThread: unknown): CodexThreadDetails | null {
  const summary = extractCodexThreadSummary(rawThread);
  if (!summary) {
    return null;
  }

  return {
    ...summary,
    conversationEntries: getCodexConversationEntriesFromThread(rawThread)
  };
}

export function getCodexThreadPreviewFromEntries(entries: CodexConversationEntry[]) {
  const latestUserPrompt = [...entries]
    .reverse()
    .find((entry) => entry.kind === "user_message" && entry.text.trim().length > 0);

  if (latestUserPrompt) {
    return normalizeSingleLine(latestUserPrompt.text);
  }

  const latestAgentMessage = [...entries]
    .reverse()
    .find((entry) => entry.kind === "agent_message" && entry.text.trim().length > 0);

  if (latestAgentMessage) {
    return normalizeSingleLine(latestAgentMessage.text);
  }

  return null;
}

export function getCodexThreadPreviewFromThread(rawThread: unknown) {
  return getCodexThreadPreviewFromEntries(getCodexConversationEntriesFromThread(rawThread));
}

export function resolveCodexThreadTitle(
  thread: CodexThreadSummary,
  localState?: CodexThreadLocalState | null
) {
  if (localState?.customTitle?.trim()) {
    return localState.customTitle.trim();
  }

  if (thread.name?.trim()) {
    return thread.name.trim();
  }

  if (thread.preview?.trim()) {
    return normalizeSingleLine(thread.preview);
  }

  return "New Chat";
}

export function normalizeSingleLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function sortCodexThreads(
  threads: CodexThreadSummary[],
  localStore: CodexThreadLocalStore
) {
  return [...threads].sort((left, right) => {
    const leftLocal = localStore.threads[left.id];
    const rightLocal = localStore.threads[right.id];
    const leftOpened = leftLocal?.lastOpenedAt ? Date.parse(leftLocal.lastOpenedAt) : Number.NaN;
    const rightOpened = rightLocal?.lastOpenedAt ? Date.parse(rightLocal.lastOpenedAt) : Number.NaN;

    if (!Number.isNaN(leftOpened) || !Number.isNaN(rightOpened)) {
      if (leftOpened !== rightOpened) {
        return (Number.isNaN(rightOpened) ? 0 : rightOpened) - (Number.isNaN(leftOpened) ? 0 : leftOpened);
      }
    }

    const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : Number.NaN;
    const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : Number.NaN;

    return (Number.isNaN(rightUpdated) ? 0 : rightUpdated) - (Number.isNaN(leftUpdated) ? 0 : leftUpdated);
  });
}
