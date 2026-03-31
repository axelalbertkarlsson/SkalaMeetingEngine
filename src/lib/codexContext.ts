import type {
  CodexContextItem,
  CodexConversationEntry,
  CodexSessionStatus
} from "../models/codex.js";

export interface CodexQueuedSend {
  id: string;
  draft: string;
  contextItems: CodexContextItem[];
  prompt: string;
}

export type CodexSendPlan =
  | { kind: "noop" }
  | { kind: "dispatch"; send: CodexQueuedSend }
  | { kind: "start_and_queue"; send: CodexQueuedSend };

export interface CodexComposerState {
  draft: string;
  contextItems: CodexContextItem[];
}

export function buildCodexPrompt(draft: string, contextItems: CodexContextItem[]) {
  const normalizedDraft = draft.replace(/\r\n/g, "\n").trim();

  if (contextItems.length === 0) {
    return normalizedDraft;
  }

  const hasInlineContext = contextItems.some((item) => typeof item.content === "string" && item.content.trim());
  const contextBlock = [
    hasInlineContext
      ? "Use these files as context. Their contents are included inline below."
      : "Use these files as context:",
    ...contextItems.flatMap((item) => {
      const normalizedContent = typeof item.content === "string"
        ? item.content.replace(/\r\n/g, "\n").trim()
        : "";

      if (!normalizedContent) {
        return [`- ${item.path}`];
      }

      return [
        `--- BEGIN FILE: ${item.label} (${item.path}) ---`,
        normalizedContent,
        `--- END FILE: ${item.label} ---`
      ];
    })
  ].join("\n");

  if (!normalizedDraft) {
    return contextBlock;
  }

  return `${contextBlock}\n\n${normalizedDraft}`;
}

export function upsertCodexContextItem(
  currentItems: CodexContextItem[],
  nextItem: CodexContextItem
) {
  const existingItem = currentItems.find((item) => item.path === nextItem.path);
  if (existingItem) {
    return {
      items: currentItems,
      highlightedItemId: existingItem.id,
      added: false
    };
  }

  return {
    items: [...currentItems, nextItem],
    highlightedItemId: nextItem.id,
    added: true
  };
}

export function createCodexQueuedSend(
  draft: string,
  contextItems: CodexContextItem[]
): CodexQueuedSend | null {
  const prompt = buildCodexPrompt(draft, contextItems);
  if (!prompt) {
    return null;
  }

  return {
    id: `codex-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    draft,
    contextItems,
    prompt
  };
}

export function planCodexSend(
  sessionStatus: CodexSessionStatus,
  draft: string,
  contextItems: CodexContextItem[]
): CodexSendPlan {
  const send = createCodexQueuedSend(draft, contextItems);
  if (!send) {
    return { kind: "noop" };
  }

  if (sessionStatus === "running") {
    return { kind: "dispatch", send };
  }

  if (sessionStatus === "starting") {
    return { kind: "start_and_queue", send };
  }

  return { kind: "start_and_queue", send };
}

export function clearComposerAfterSuccessfulSend(): CodexComposerState {
  return {
    draft: "",
    contextItems: []
  };
}

export function extractTextFromUserMessageContent(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      if ("type" in part) {
        const type = (part as { type?: string }).type;
        if (type === "text" || type === "input_text") {
          const textValue = (part as { text?: unknown }).text;
          if (typeof textValue === "string") {
            return textValue;
          }

          if (
            textValue
            && typeof textValue === "object"
            && typeof (textValue as { value?: unknown }).value === "string"
          ) {
            return (textValue as { value: string }).value;
          }
        }
      }

      if ("path" in part && typeof (part as { path?: unknown }).path === "string") {
        return (part as { path: string }).path;
      }

      if ("name" in part && typeof (part as { name?: unknown }).name === "string") {
        return (part as { name: string }).name;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeFileChangeText(item: Record<string, unknown>) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) {
    return "Proposed file changes.";
  }

  return changes
    .map((change) => {
      if (!change || typeof change !== "object") {
        return "Updated file";
      }

      const kind = typeof (change as { kind?: unknown }).kind === "string"
        ? (change as { kind: string }).kind
        : "update";
      const path = typeof (change as { path?: unknown }).path === "string"
        ? (change as { path: string }).path
        : "Unknown file";
      return `${kind}: ${path}`;
    })
    .join("\n");
}

const REASONING_FALLBACK_TEXT = "Codex is reasoning about the current turn.";
const loggedReasoningFallbackItemIds = new Set<string>();
const MAX_REASONING_VISIT_DEPTH = 6;
const MAX_REASONING_TEXT_PARTS = 48;
const MAX_REASONING_TEXT_LENGTH = 8_000;
const MAX_COMMAND_DISPLAY_TEXT_LENGTH = 16_000;
const TRUNCATED_COMMAND_OUTPUT_NOTICE = "\n\n[output truncated for display]";

function collectReasoningText(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): string[] {
  if (depth > MAX_REASONING_VISIT_DEPTH) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    value.forEach((entry) => {
      if (parts.length >= MAX_REASONING_TEXT_PARTS) {
        return;
      }

      const nextParts = collectReasoningText(entry, seen, depth + 1);
      nextParts.forEach((part) => {
        if (parts.length < MAX_REASONING_TEXT_PARTS) {
          parts.push(part);
        }
      });
    });
    return parts;
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (seen.has(value as object)) {
    return [];
  }

  seen.add(value as object);
  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "text",
    "value",
    "summary",
    "content",
    "output",
    "reasoning",
    "message",
    "description",
    "explanation",
    "details"
  ];

  for (const key of preferredKeys) {
    const nextParts = collectReasoningText(record[key], seen, depth + 1);
    if (nextParts.length > 0) {
      return nextParts.slice(0, MAX_REASONING_TEXT_PARTS);
    }
  }

  return [];
}

function normalizeReasoningText(parts: string[]) {
  if (parts.length === 0) {
    return "";
  }

  const uniqueParts = Array.from(
    new Set(parts.map((part) => part.trim()).filter(Boolean))
  ).slice(0, MAX_REASONING_TEXT_PARTS);

  const joined = uniqueParts.join("\n");
  return joined.length > MAX_REASONING_TEXT_LENGTH
    ? `${joined.slice(0, MAX_REASONING_TEXT_LENGTH).trimEnd()}\n...`
    : joined;
}

function clampConversationEntryText(kind: CodexConversationEntry["kind"], text: string) {
  if (kind !== "command_execution" && kind !== "file_change") {
    return text;
  }

  if (text.length <= MAX_COMMAND_DISPLAY_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_COMMAND_DISPLAY_TEXT_LENGTH).trimEnd()}${TRUNCATED_COMMAND_OUTPUT_NOTICE}`;
}

function debugReasoningFallback(item: Record<string, unknown>) {
  const itemId = typeof item.id === "string" ? item.id : JSON.stringify(Object.keys(item).sort());
  if (loggedReasoningFallbackItemIds.has(itemId)) {
    return;
  }

  loggedReasoningFallbackItemIds.add(itemId);
  console.debug("[codex] reasoning fallback", {
    id: item.id ?? null,
    type: item.type ?? null,
    keys: Object.keys(item),
    summaryType: Array.isArray(item.summary) ? "array" : typeof item.summary,
    contentType: Array.isArray(item.content) ? "array" : typeof item.content,
    textType: typeof item.text,
    reasoningType: Array.isArray(item.reasoning) ? "array" : typeof item.reasoning
  });
}

function summarizeReasoningText(item: Record<string, unknown>) {
  const summary = normalizeReasoningText(collectReasoningText(item.summary));
  const content = normalizeReasoningText(collectReasoningText(item.content));
  const directText = normalizeReasoningText(collectReasoningText(item.text));

  if (summary && content) {
    return `${summary}\n\n${content}`;
  }

  if (summary) {
    return summary;
  }

  if (content) {
    return content;
  }

  if (directText) {
    return directText;
  }

  debugReasoningFallback(item);
  return REASONING_FALLBACK_TEXT;
}

function summarizeMcpToolCallText(item: Record<string, unknown>) {
  const result = item.result;
  const error = item.error;
  const argumentsValue = item.arguments;

  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }

  if (result && typeof result === "object") {
    return JSON.stringify(result, null, 2);
  }

  if (argumentsValue !== undefined) {
    return JSON.stringify(argumentsValue, null, 2);
  }

  return "Tool call in progress.";
}

function summarizeDynamicToolCallText(item: Record<string, unknown>) {
  const contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
  if (contentItems.length) {
    return JSON.stringify(contentItems, null, 2);
  }

  if (item.arguments !== undefined) {
    return JSON.stringify(item.arguments, null, 2);
  }

  return "Dynamic tool call in progress.";
}

export function createCodexConversationEntryFromItem(
  item: unknown,
  turnId: string
): CodexConversationEntry | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const itemId = typeof record.id === "string" ? record.id : null;
  const type = typeof record.type === "string" ? record.type : null;

  if (!itemId || !type) {
    return null;
  }

  if (type === "userMessage") {
    const text =
      extractTextFromUserMessageContent(record.content)
      || (typeof record.text === "string" ? record.text : "");
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "user_message",
      meta: null,
      phase: null,
      status: null,
      text,
      title: "You",
      turnId
    };
  }

  if (type === "agentMessage") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "agent_message",
      meta: null,
      phase: typeof record.phase === "string" ? record.phase : null,
      status: null,
      text: typeof record.text === "string" ? record.text : "",
      title: "Codex",
      turnId
    };
  }

  if (type === "commandExecution") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "command_execution",
      meta: typeof record.cwd === "string" ? record.cwd : null,
      phase: null,
      status: typeof record.status === "string" ? record.status : null,
      text: clampConversationEntryText(
        "command_execution",
        typeof record.aggregatedOutput === "string" ? record.aggregatedOutput : ""
      ),
      title: typeof record.command === "string" ? record.command : "Command",
      turnId
    };
  }

  if (type === "fileChange") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "file_change",
      meta: null,
      phase: null,
      status: typeof record.status === "string" ? record.status : null,
      text: clampConversationEntryText("file_change", summarizeFileChangeText(record)),
      title: "File changes",
      turnId
    };
  }

  if (type === "reasoning") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: null,
      phase: null,
      status: null,
      text: summarizeReasoningText(record),
      title: "Reasoning",
      turnId
    };
  }

  if (type === "plan") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: null,
      phase: null,
      status: null,
      text: typeof record.text === "string" ? record.text : "Codex proposed a plan item.",
      title: "Plan",
      turnId
    };
  }

  if (type === "mcpToolCall") {
    const server = typeof record.server === "string" ? record.server : "MCP";
    const tool = typeof record.tool === "string" ? record.tool : "tool";
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: `${server}`,
      phase: null,
      status: typeof record.status === "string" ? record.status : null,
      text: summarizeMcpToolCallText(record),
      title: `${tool}`,
      turnId
    };
  }

  if (type === "dynamicToolCall") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: null,
      phase: null,
      status: typeof record.status === "string" ? record.status : null,
      text: summarizeDynamicToolCallText(record),
      title: typeof record.tool === "string" ? record.tool : "Dynamic tool call",
      turnId
    };
  }

  if (type === "webSearch") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: null,
      phase: null,
      status: null,
      text: typeof record.query === "string" ? record.query : "Web search started.",
      title: "Web search",
      turnId
    };
  }

  if (type === "imageView") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: null,
      phase: null,
      status: null,
      text: typeof record.path === "string" ? record.path : "Viewed an image.",
      title: "Image view",
      turnId
    };
  }

  if (type === "imageGeneration") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: null,
      phase: null,
      status: typeof record.status === "string" ? record.status : null,
      text: typeof record.result === "string" ? record.result : "Image generation item.",
      title: "Image generation",
      turnId
    };
  }

  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: null,
      phase: null,
      status: null,
      text: typeof record.review === "string" ? record.review : "Codex changed review mode.",
      title: type === "enteredReviewMode" ? "Entered review mode" : "Exited review mode",
      turnId
    };
  }

  if (type === "contextCompaction") {
    return {
      id: `conversation-${itemId}`,
      itemId,
      kind: "event",
      meta: null,
      phase: null,
      status: null,
      text: "Codex compacted the thread context to continue the session.",
      title: "Context compaction",
      turnId
    };
  }

  return {
    id: `conversation-${itemId}`,
    itemId,
    kind: "event",
    meta: null,
    phase: null,
    status: null,
    text: JSON.stringify(record, null, 2),
    title: type,
    turnId
  };
}

export function appendTextToConversationEntry(
  entries: CodexConversationEntry[],
  itemId: string,
  delta: string
) {
  return entries.map((entry) => {
    if (entry.itemId !== itemId) {
      return entry;
    }

    return {
      ...entry,
      text: clampConversationEntryText(entry.kind, `${entry.text}${delta}`)
    };
  });
}

export function upsertConversationEntry(
  entries: CodexConversationEntry[],
  nextEntry: CodexConversationEntry
) {
  const existingIndex = entries.findIndex((entry) => entry.itemId === nextEntry.itemId);
  if (existingIndex === -1) {
    if (nextEntry.kind === "user_message" && nextEntry.turnId) {
      const optimisticIndex = entries.findIndex(
        (entry) =>
          entry.kind === "user_message"
          && !entry.itemId
          && entry.turnId === nextEntry.turnId
      );

      if (optimisticIndex !== -1) {
        return entries.map((entry, index) =>
          index === optimisticIndex
            ? {
                ...entry,
                ...nextEntry,
                text: entry.text || nextEntry.text
              }
            : entry
        );
      }
    }

    return [...entries, nextEntry];
  }

  return entries.map((entry, index) =>
    index === existingIndex
      ? {
          ...entry,
          ...nextEntry,
          text: nextEntry.text || entry.text
        }
      : entry
  );
}

export function createCodexEventEntry(
  title: string,
  text: string,
  options?: {
    id?: string;
    status?: string | null;
    turnId?: string | null;
    meta?: string | null;
  }
): CodexConversationEntry {
  return {
    id: options?.id ?? `conversation-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "event",
    title,
    text,
    meta: options?.meta ?? null,
    phase: null,
    status: options?.status ?? null,
    turnId: options?.turnId ?? undefined
  };
}
