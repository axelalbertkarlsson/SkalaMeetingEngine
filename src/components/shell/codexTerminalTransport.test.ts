import {
  consumeTerminalSyncOutput,
  createTerminalSyncOutputState,
  createTerminalSequenceState,
  decodeBase64ToUint8Array,
  enqueueTerminalWrite,
  flushTerminalWriteSequence,
  getTerminalIdleThresholdMs,
  getTerminalResizeDelayMs,
  getTerminalWriteFlushDelayMs,
  getTerminalVisualResetReason,
  shouldDeferTerminalResize,
  shouldForceTerminalResize,
  type TerminalQueuedWrite
} from "./codexTerminalTransport.js";
import {
  appendTextToConversationEntry,
  buildCodexPrompt,
  clearComposerAfterSuccessfulSend,
  createCodexConversationEntryFromItem,
  extractTextFromUserMessageContent,
  planCodexSend,
  upsertCodexContextItem
} from "../../lib/codexContext.js";
import {
  createInitialCodexThreadLocalState,
  extractCodexThreadDetails,
  getCodexThreadLocalStoreKey,
  resolveCodexThreadTitle,
  sanitizeCodexThreadLocalStore,
  sortCodexThreads
} from "../../lib/codexThreads.js";
import type { CodexContextItem } from "../../models/codex.js";

export interface TerminalHelperTestCase {
  name: string;
  run: () => void;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asText(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((value) => String.fromCharCode(value))
    .join("");
}

function asBytes(text: string) {
  return new Uint8Array(
    Array.from(text).map((character) => character.charCodeAt(0))
  );
}

function asPtyWrite(seq: number, text: string): TerminalQueuedWrite {
  const bytes = new Uint8Array(
    Array.from(text).map((character) => character.charCodeAt(0))
  );

  return {
    kind: "pty",
    seq,
    data: bytes
  };
}

function asContextItem(path: string, label = "Context file"): CodexContextItem {
  return {
    id: `ctx-${label.toLowerCase().replace(/\s+/g, "-")}`,
    kind: "document_note",
    label,
    path,
    sourceId: label
  };
}

export const tests: TerminalHelperTestCase[] = [
  {
    name: "decodeBase64ToUint8Array preserves CRLF bytes",
    run() {
      const decoded = decodeBase64ToUint8Array("SGVsbG8NCg==");
      assert(asText(decoded) === "Hello\r\n", `expected CRLF payload, received ${JSON.stringify(asText(decoded))}`);
    }
  },
  {
    name: "enqueueTerminalWrite reorders contiguous writes once gaps close",
    run() {
      let state = createTerminalSequenceState(0);

      const first = enqueueTerminalWrite(state, asPtyWrite(1, "B"), 0);
      state = first.state;
      assert(first.ready.length === 0, "out-of-order seq should not become ready immediately");

      const second = enqueueTerminalWrite(state, asPtyWrite(0, "A"), 10);
      state = second.state;
      assert(second.ready.length === 2, `expected 2 ready writes, received ${second.ready.length}`);
      assert(
        second.ready.map((entry: TerminalQueuedWrite) => entry.seq).join(",") === "0,1",
        `expected seq order 0,1 but received ${second.ready.map((entry: TerminalQueuedWrite) => entry.seq).join(",")}`
      );
      assert(state.expectedSeq === 2, `expected next seq 2, received ${state.expectedSeq}`);
    }
  },
  {
    name: "flushTerminalWriteSequence skips stalled gaps after timeout",
    run() {
      const enqueued = enqueueTerminalWrite(createTerminalSequenceState(0), asPtyWrite(2, "C"), 0);
      assert(enqueued.state.gapDeadlineMs === 50, `expected gap deadline 50, received ${String(enqueued.state.gapDeadlineMs)}`);

      const pending = flushTerminalWriteSequence(enqueued.state, 60);
      assert(pending.skippedRange?.fromSeq === 0, "expected skipped range to start at seq 0");
      assert(pending.skippedRange?.toSeq === 1, "expected skipped range to end at seq 1");
      assert(pending.ready.length === 1, `expected exactly one ready write after skip, received ${pending.ready.length}`);
      assert(pending.ready[0]?.seq === 2, `expected seq 2 after gap skip, received ${String(pending.ready[0]?.seq)}`);
    }
  },
  {
    name: "consumeTerminalSyncOutput buffers synchronized output until the end marker arrives",
    run() {
      const start = "\u001b[?2026h";
      const end = "\u001b[?2026l";
      let state = createTerminalSyncOutputState();

      const first = consumeTerminalSyncOutput(state, asBytes(`A${start}B`));
      state = first.state;
      assert(first.ready.length === 1, `expected one immediate ready chunk, received ${first.ready.length}`);
      assert(asText(first.ready[0] ?? new Uint8Array()) === "A", "expected normal bytes before sync mode to flush immediately");
      assert(state.active, "expected synchronized output mode to remain active");

      const second = consumeTerminalSyncOutput(state, asBytes(`C${end}D`));
      state = second.state;
      assert(!state.active, "expected synchronized output mode to close");
      assert(second.ready.length === 2, `expected buffered sync bytes plus trailing bytes, received ${second.ready.length}`);
      assert(asText(second.ready[0] ?? new Uint8Array()) === "BC", "expected buffered sync bytes to flush atomically");
      assert(asText(second.ready[1] ?? new Uint8Array()) === "D", "expected post-sync bytes to remain visible");
    }
  },
  {
    name: "consumeTerminalSyncOutput handles split sync markers across PTY chunk boundaries",
    run() {
      let state = createTerminalSyncOutputState();

      let update = consumeTerminalSyncOutput(state, asBytes("A\u001b[?20"));
      state = update.state;
      assert(update.ready.length === 1, `expected visible prefix to flush immediately, received ${update.ready.length}`);
      assert(asText(update.ready[0] ?? new Uint8Array()) === "A", "expected non-marker bytes to pass through");
      assert(state.carry.length > 0, "expected a partial sync marker to be retained as carry");

      update = consumeTerminalSyncOutput(state, asBytes("26hBC"));
      state = update.state;
      assert(update.ready.length === 0, "expected bytes inside sync mode to remain buffered");
      assert(state.active, "expected sync mode to become active after the split marker completes");

      update = consumeTerminalSyncOutput(state, asBytes("\u001b[?2026lD"));
      state = update.state;
      assert(!state.active, "expected sync mode to close after the end marker");
      assert(update.ready.length === 2, `expected buffered sync bytes and trailing bytes, received ${update.ready.length}`);
      assert(asText(update.ready[0] ?? new Uint8Array()) === "BC", "expected buffered sync body to flush once");
      assert(asText(update.ready[1] ?? new Uint8Array()) === "D", "expected trailing bytes after sync mode to remain visible");
    }
  },
  {
    name: "shouldDeferTerminalResize only blocks focused active input windows",
    run() {
      assert(
        shouldDeferTerminalResize({ isFocused: true, lastInputAtMs: 1000, nowMs: 1100 }),
        "expected resize deferral while input is active"
      );
      assert(
        !shouldDeferTerminalResize({ isFocused: true, lastInputAtMs: 1000, nowMs: 1250 }),
        "expected no deferral once the idle threshold has elapsed"
      );
      assert(
        !shouldDeferTerminalResize({ isFocused: false, lastInputAtMs: 1000, nowMs: 1010 }),
        "expected no deferral while terminal is blurred"
      );
      assert(
        getTerminalResizeDelayMs({ lastInputAtMs: 1000, nowMs: 1100 }) === 150,
        "expected remaining resize delay of 150ms"
      );
    }
  },
  {
    name: "full-screen resize behavior uses shorter idle windows and bounded deferral",
    run() {
      assert(
        getTerminalIdleThresholdMs("full_screen") === 120,
        "expected full-screen idle threshold to be shortened"
      );
      assert(
        getTerminalIdleThresholdMs("compact") === 250,
        "expected compact mode to retain the default idle threshold"
      );
      assert(
        shouldForceTerminalResize({ pendingSinceMs: 1000, nowMs: 1450 }),
        "expected long deferrals to be forced through"
      );
      assert(
        !shouldForceTerminalResize({ pendingSinceMs: 1000, nowMs: 1200 }),
        "expected recent resize requests to remain deferrable"
      );
    }
  },
  {
    name: "getTerminalVisualResetReason only resets for clear or new session attach",
    run() {
      assert(
        getTerminalVisualResetReason({
          previousSessionId: "codex-1",
          nextSessionId: "codex-1",
          clearSignalChanged: false
        }) === null,
        "expected no reset for routine session updates"
      );
      assert(
        getTerminalVisualResetReason({
          previousSessionId: "codex-1",
          nextSessionId: "codex-2",
          clearSignalChanged: false
        }) === "session_attached",
        "expected a reset when a new session attaches"
      );
      assert(
        getTerminalVisualResetReason({
          previousSessionId: "codex-2",
          nextSessionId: "codex-2",
          clearSignalChanged: true
        }) === "clear_requested",
        "expected an explicit clear to reset the terminal"
      );
    }
  },
  {
    name: "getTerminalWriteFlushDelayMs frame-batches full-screen PTY traffic only",
    run() {
      assert(
        getTerminalWriteFlushDelayMs({
          terminalMode: "full_screen",
          hasPtyWrite: true,
          ptyByteLength: 10
        }) === 16,
        "expected full-screen PTY writes to be deferred to the next frame"
      );
      assert(
        getTerminalWriteFlushDelayMs({
          terminalMode: "full_screen",
          hasPtyWrite: true,
          ptyByteLength: 120
        }) === 48,
        "expected larger full-screen PTY repaints to use an extended flush window"
      );
      assert(
        getTerminalWriteFlushDelayMs({
          terminalMode: "full_screen",
          hasPtyWrite: false,
          ptyByteLength: 120
        }) === 0,
        "expected non-PTY writes to stay immediate"
      );
      assert(
        getTerminalWriteFlushDelayMs({
          terminalMode: "compact",
          hasPtyWrite: true,
          ptyByteLength: 120
        }) === 0,
        "expected compact PTY writes to remain immediate"
      );
    }
  },
  {
    name: "upsertCodexContextItem deduplicates by absolute path and highlights the existing chip",
    run() {
      const first = asContextItem("C:\\notes\\sync.md", "Sync");
      const duplicate = asContextItem("C:\\notes\\sync.md", "Another label");
      const result = upsertCodexContextItem([first], duplicate);

      assert(result.items.length === 1, `expected one chip after dedupe, received ${result.items.length}`);
      assert(result.highlightedItemId === first.id, `expected ${first.id} to be highlighted`);
      assert(!result.added, "expected duplicate add to avoid appending a second chip");
    }
  },
  {
    name: "buildCodexPrompt serializes explicit file context before the user draft",
    run() {
      const prompt = buildCodexPrompt("Summarize the meeting.", [
        asContextItem("C:\\meeting\\cleaned.md", "Cleaned transcript"),
        asContextItem("C:\\notes\\plan.md", "Planning note")
      ]);

      assert(
        prompt === "Use these files as context:\n- C:\\meeting\\cleaned.md\n- C:\\notes\\plan.md\n\nSummarize the meeting.",
        `unexpected prompt serialization: ${JSON.stringify(prompt)}`
      );

      assert(
        buildCodexPrompt("Just draft", []) === "Just draft",
        "expected plain draft to pass through when no chips are staged"
      );
    }
  },
  {
    name: "planCodexSend queues the prompt when the first send must start a session",
    run() {
      const plan = planCodexSend("idle", "Review this note.", [
        asContextItem("C:\\notes\\review.md", "Review note")
      ]);

      assert(plan.kind === "start_and_queue", `expected queued send plan, received ${plan.kind}`);
      if (plan.kind !== "start_and_queue") {
        throw new Error("expected start_and_queue plan");
      }

      assert(
        plan.send.prompt.includes("Use these files as context:"),
        "expected queued send prompt to include explicit file context"
      );
    }
  },
  {
    name: "clearComposerAfterSuccessfulSend resets the draft and one-turn context chips",
    run() {
      const nextState = clearComposerAfterSuccessfulSend();
      assert(nextState.draft === "", "expected draft to clear after a successful send");
      assert(nextState.contextItems.length === 0, "expected one-turn context chips to clear after send");
    }
  },
  {
    name: "extractTextFromUserMessageContent keeps text payloads and mention paths readable",
    run() {
      const text = extractTextFromUserMessageContent([
        { type: "text", text: "Use the transcript." },
        { type: "mention", name: "transcript.md", path: "C:\\notes\\transcript.md" }
      ]);

      assert(
        text === "Use the transcript.\nC:\\notes\\transcript.md",
        `unexpected extracted user message text: ${JSON.stringify(text)}`
      );
    }
  },
  {
    name: "createCodexConversationEntryFromItem maps agent and command items into feed entries",
    run() {
      const agentEntry = createCodexConversationEntryFromItem(
        {
          id: "agent-1",
          type: "agentMessage",
          text: "I reviewed the transcript.",
          phase: "final_answer"
        },
        "turn-1"
      );
      const commandEntry = createCodexConversationEntryFromItem(
        {
          id: "cmd-1",
          type: "commandExecution",
          command: "rg TODO",
          cwd: "C:\\workspace",
          status: "completed",
          aggregatedOutput: "TODO: fix transcript"
        },
        "turn-1"
      );

      assert(agentEntry?.kind === "agent_message", "expected an agent message entry");
      assert(agentEntry?.text === "I reviewed the transcript.", "expected agent text to carry through");
      assert(commandEntry?.kind === "command_execution", "expected a command execution entry");
      assert(commandEntry?.meta === "C:\\workspace", "expected the command cwd to be preserved");
    }
  },
  {
    name: "appendTextToConversationEntry appends deltas onto the matching item only",
    run() {
      const updated = appendTextToConversationEntry(
        [
          {
            id: "conversation-agent-1",
            itemId: "agent-1",
            kind: "agent_message",
            title: "Codex",
            text: "Partial",
            turnId: "turn-1"
          },
          {
            id: "conversation-event-1",
            itemId: "event-1",
            kind: "event",
            title: "Event",
            text: "Static"
          }
        ],
        "agent-1",
        " answer"
      );

      assert(updated[0]?.text === "Partial answer", "expected the matching entry to receive the delta");
      assert(updated[1]?.text === "Static", "expected non-matching entries to remain unchanged");
    }
  },
  {
    name: "resolveCodexThreadTitle prefers local rename over server title and preview",
    run() {
      const title = resolveCodexThreadTitle(
        {
          id: "thread-1",
          name: "Server title",
          preview: "Prompt preview",
          createdAt: null,
          updatedAt: null,
          status: "idle",
          archived: false
        },
        {
          ...createInitialCodexThreadLocalState(),
          customTitle: "Local title"
        }
      );

      assert(title === "Local title", `expected local title override, received ${JSON.stringify(title)}`);
    }
  },
  {
    name: "sanitizeCodexThreadLocalStore keeps valid thread drafts and drops malformed values",
    run() {
      const store = sanitizeCodexThreadLocalStore({
        lastOpenedThreadId: "thread-1",
        threads: {
          "thread-1": {
            customTitle: "Renamed",
            draft: "Continue this",
            contextItems: [asContextItem("C:\\notes\\one.md", "One")],
            lastOpenedAt: "2026-03-24T08:00:00.000Z",
            lastSubmittedPrompt: "Previous prompt"
          },
          "thread-2": "bad"
        }
      });

      assert(store.lastOpenedThreadId === "thread-1", "expected last opened thread id to survive sanitization");
      assert(store.threads["thread-1"]?.draft === "Continue this", "expected valid thread draft to survive");
      assert(store.threads["thread-1"]?.contextItems.length === 1, "expected valid context items to survive");
      assert(store.threads["thread-2"]?.draft === "", "expected malformed thread state to reset");
      assert(
        getCodexThreadLocalStoreKey("C:\\workspace") === "codex.threadHistory.C:\\workspace",
        "expected workspace-scoped local-storage key"
      );
    }
  },
  {
    name: "extractCodexThreadDetails hydrates full conversation entries from thread turns",
    run() {
      const details = extractCodexThreadDetails({
        id: "thread-1",
        name: null,
        updatedAt: "2026-03-24T09:30:00.000Z",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                id: "msg-user-1",
                type: "userMessage",
                role: "user",
                content: [{ type: "text", text: "Summarize this transcript." }]
              },
              {
                id: "msg-agent-1",
                type: "agentMessage",
                text: "Here is the summary."
              }
            ]
          }
        ]
      });

      assert(details?.id === "thread-1", "expected thread details to be created");
      assert(details?.preview === "Summarize this transcript.", "expected preview from first real user message");
      assert(details?.conversationEntries.length === 2, "expected both user and agent entries to hydrate");
      assert(details?.conversationEntries[0]?.kind === "user_message", "expected first hydrated entry to be the user message");
    }
  },
  {
    name: "sortCodexThreads prefers recently opened local chats before updated timestamps",
    run() {
      const sorted = sortCodexThreads(
        [
          {
            id: "thread-older",
            name: "Older",
            preview: null,
            createdAt: null,
            updatedAt: "2026-03-24T09:00:00.000Z",
            status: "idle",
            archived: false
          },
          {
            id: "thread-recent",
            name: "Recent",
            preview: null,
            createdAt: null,
            updatedAt: "2026-03-24T10:00:00.000Z",
            status: "idle",
            archived: false
          }
        ],
        {
          lastOpenedThreadId: "thread-older",
          threads: {
            "thread-older": {
              ...createInitialCodexThreadLocalState(),
              lastOpenedAt: "2026-03-24T11:00:00.000Z"
            }
          }
        }
      );

      assert(sorted[0]?.id === "thread-older", "expected locally reopened thread to sort first");
    }
  }
];
