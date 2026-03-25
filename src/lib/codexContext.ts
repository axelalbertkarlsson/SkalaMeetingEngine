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

  const contextBlock = [
    "Use these files as context:",
    ...contextItems.map((item) => `- ${item.path}`)
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

function summarizeReasoningText(item: Record<string, unknown>) {
  const summary = Array.isArray(item.summary) ? item.summary.filter((entry): entry is string => typeof entry === "string") : [];
  const content = Array.isArray(item.content) ? item.content.filter((entry): entry is string => typeof entry === "string") : [];

  if (summary.length && content.length) {
    return `${summary.join("\n")}\n\n${content.join("\n")}`;
  }

  if (summary.length) {
    return summary.join("\n");
  }

  if (content.length) {
    return content.join("\n");
  }

  return "Codex is reasoning about the current turn.";
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
      text: typeof record.aggregatedOutput === "string" ? record.aggregatedOutput : "",
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
      text: summarizeFileChangeText(record),
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
      text: `${entry.text}${delta}`
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
