export interface TerminalPtyChunkEventPayload {
  kind: "pty";
  session_id: string;
  seq: number;
  data_base64: string;
}

export interface TerminalSystemChunkEventPayload {
  kind: "system";
  session_id: string;
  seq: number;
  text: string;
}

export type TerminalChunkEventPayload = TerminalPtyChunkEventPayload | TerminalSystemChunkEventPayload;

export interface TerminalPtyWrite {
  kind: "pty";
  seq: number;
  data: Uint8Array;
}

export interface TerminalSystemWrite {
  kind: "system";
  seq: number;
  text: string;
}

export type TerminalQueuedWrite = TerminalPtyWrite | TerminalSystemWrite;

export interface TerminalSequenceState {
  expectedSeq: number;
  pending: TerminalQueuedWrite[];
  gapDeadlineMs: number | null;
}

export interface TerminalSequenceUpdate {
  state: TerminalSequenceState;
  ready: TerminalQueuedWrite[];
  skippedRange: { fromSeq: number; toSeq: number } | null;
}

export const DEFAULT_SEQUENCE_GAP_TIMEOUT_MS = 50;
export const DEFAULT_TERMINAL_IDLE_MS = 250;

function compareWrites(left: TerminalQueuedWrite, right: TerminalQueuedWrite) {
  return left.seq - right.seq;
}

function upsertPendingWrite(pending: TerminalQueuedWrite[], nextWrite: TerminalQueuedWrite) {
  const withoutDuplicates = pending.filter((entry) => entry.seq !== nextWrite.seq);
  withoutDuplicates.push(nextWrite);
  withoutDuplicates.sort(compareWrites);
  return withoutDuplicates;
}

function consumeReadyWrites(pending: TerminalQueuedWrite[], expectedSeq: number) {
  const ready: TerminalQueuedWrite[] = [];
  let nextExpectedSeq = expectedSeq;
  const remaining = [...pending];

  while (remaining[0]?.seq === nextExpectedSeq) {
    const nextWrite = remaining.shift();
    if (!nextWrite) {
      break;
    }

    ready.push(nextWrite);
    nextExpectedSeq += 1;
  }

  return {
    pending: remaining,
    ready,
    expectedSeq: nextExpectedSeq
  };
}

function nextGapDeadline(
  pending: TerminalQueuedWrite[],
  expectedSeq: number,
  nowMs: number,
  previousDeadlineMs: number | null,
  gapTimeoutMs: number,
  resetDeadline: boolean
) {
  if (!pending.length || pending[0].seq <= expectedSeq) {
    return null;
  }

  if (resetDeadline || previousDeadlineMs === null || previousDeadlineMs <= nowMs) {
    return nowMs + gapTimeoutMs;
  }

  return previousDeadlineMs;
}

export function createTerminalSequenceState(expectedSeq = 0): TerminalSequenceState {
  return {
    expectedSeq,
    pending: [],
    gapDeadlineMs: null
  };
}

export function decodeBase64ToUint8Array(data: string) {
  if (!data) {
    return new Uint8Array();
  }

  if (typeof globalThis.atob === "function") {
    const decoded = globalThis.atob(data);
    const bytes = new Uint8Array(decoded.length);

    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }

    return bytes;
  }

  const bufferCtor = (
    globalThis as unknown as {
      Buffer?: {
        from: (input: string, encoding: string) => Uint8Array;
      };
    }
  ).Buffer;

  if (!bufferCtor) {
    throw new Error("No base64 decoder available in this runtime.");
  }

  return Uint8Array.from(bufferCtor.from(data, "base64"));
}

export function encodeUint8ArrayToBase64(data: Uint8Array) {
  if (data.length === 0) {
    return "";
  }

  if (typeof globalThis.btoa === "function") {
    let text = "";
    for (const byte of data) {
      text += String.fromCharCode(byte);
    }

    return globalThis.btoa(text);
  }

  const bufferCtor = (
    globalThis as unknown as {
      Buffer?: {
        from: (input: Uint8Array) => { toString: (encoding: string) => string };
      };
    }
  ).Buffer;

  if (!bufferCtor) {
    throw new Error("No base64 encoder available in this runtime.");
  }

  return bufferCtor.from(data).toString("base64");
}

export function encodeTextToBase64(text: string) {
  return encodeUint8ArrayToBase64(new TextEncoder().encode(text));
}

export function enqueueTerminalWrite(
  state: TerminalSequenceState,
  nextWrite: TerminalQueuedWrite,
  nowMs: number,
  gapTimeoutMs = DEFAULT_SEQUENCE_GAP_TIMEOUT_MS
): TerminalSequenceUpdate {
  if (nextWrite.seq < state.expectedSeq) {
    return {
      state,
      ready: [],
      skippedRange: null
    };
  }

  const pending = upsertPendingWrite(state.pending, nextWrite);
  const consumed = consumeReadyWrites(pending, state.expectedSeq);

  return {
    state: {
      expectedSeq: consumed.expectedSeq,
      pending: consumed.pending,
      gapDeadlineMs: nextGapDeadline(
        consumed.pending,
        consumed.expectedSeq,
        nowMs,
        state.gapDeadlineMs,
        gapTimeoutMs,
        consumed.ready.length > 0
      )
    },
    ready: consumed.ready,
    skippedRange: null
  };
}

export function flushTerminalWriteSequence(
  state: TerminalSequenceState,
  nowMs: number,
  gapTimeoutMs = DEFAULT_SEQUENCE_GAP_TIMEOUT_MS
): TerminalSequenceUpdate {
  let expectedSeq = state.expectedSeq;
  let skippedRange: { fromSeq: number; toSeq: number } | null = null;

  if (
    state.gapDeadlineMs !== null &&
    state.pending.length > 0 &&
    state.pending[0].seq > expectedSeq &&
    nowMs >= state.gapDeadlineMs
  ) {
    skippedRange = {
      fromSeq: expectedSeq,
      toSeq: state.pending[0].seq - 1
    };
    expectedSeq = state.pending[0].seq;
  }

  const consumed = consumeReadyWrites(state.pending, expectedSeq);

  return {
    state: {
      expectedSeq: consumed.expectedSeq,
      pending: consumed.pending,
      gapDeadlineMs: nextGapDeadline(
        consumed.pending,
        consumed.expectedSeq,
        nowMs,
        null,
        gapTimeoutMs,
        true
      )
    },
    ready: consumed.ready,
    skippedRange
  };
}

export function shouldDeferTerminalResize(options: {
  isFocused: boolean;
  lastInputAtMs: number | null;
  nowMs: number;
  idleThresholdMs?: number;
}) {
  const { isFocused, lastInputAtMs, nowMs, idleThresholdMs = DEFAULT_TERMINAL_IDLE_MS } = options;

  if (!isFocused || lastInputAtMs === null) {
    return false;
  }

  return nowMs - lastInputAtMs < idleThresholdMs;
}

export function getTerminalResizeDelayMs(options: {
  lastInputAtMs: number | null;
  nowMs: number;
  idleThresholdMs?: number;
}) {
  const { lastInputAtMs, nowMs, idleThresholdMs = DEFAULT_TERMINAL_IDLE_MS } = options;

  if (lastInputAtMs === null) {
    return 0;
  }

  return Math.max(0, idleThresholdMs - (nowMs - lastInputAtMs));
}
