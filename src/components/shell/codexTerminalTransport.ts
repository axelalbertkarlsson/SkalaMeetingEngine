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

export interface TerminalSyncOutputState {
  active: boolean;
  carry: Uint8Array;
  bufferedChunks: Uint8Array[];
  bufferedLength: number;
}

export interface TerminalSyncOutputUpdate {
  state: TerminalSyncOutputState;
  ready: Uint8Array[];
}

export const DEFAULT_SEQUENCE_GAP_TIMEOUT_MS = 50;
export const DEFAULT_TERMINAL_IDLE_MS = 250;
export const FULL_SCREEN_TERMINAL_IDLE_MS = 120;
export const MAX_TERMINAL_RESIZE_DEFERRAL_MS = 400;
export const FULL_SCREEN_PTY_WRITE_FLUSH_DELAY_MS = 16;
export const FULL_SCREEN_LARGE_PTY_WRITE_FLUSH_DELAY_MS = 48;
export const LARGE_FULL_SCREEN_PTY_WRITE_BYTES = 90;
export const MAX_SYNC_OUTPUT_BUFFER_BYTES = 1024 * 1024;

export type TerminalMode = "full_screen" | "compact";
export type TerminalVisualResetReason = "clear_requested" | "session_attached";

const SYNC_OUTPUT_START_SEQUENCE = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]);
const SYNC_OUTPUT_END_SEQUENCE = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);

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

function concatUint8Arrays(chunks: Uint8Array[], totalLength: number) {
  const combined = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}

function findSequenceIndex(bytes: Uint8Array, sequence: Uint8Array, fromIndex: number) {
  const maxStartIndex = bytes.length - sequence.length;

  for (let startIndex = fromIndex; startIndex <= maxStartIndex; startIndex += 1) {
    let matches = true;

    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (bytes[startIndex + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return startIndex;
    }
  }

  return -1;
}

function getSequenceCarryLength(bytes: Uint8Array, sequence: Uint8Array) {
  const maxCarryLength = Math.min(bytes.length, sequence.length - 1);

  for (let carryLength = maxCarryLength; carryLength > 0; carryLength -= 1) {
    let matches = true;

    for (let offset = 0; offset < carryLength; offset += 1) {
      if (bytes[bytes.length - carryLength + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return carryLength;
    }
  }

  return 0;
}

export function createTerminalSequenceState(expectedSeq = 0): TerminalSequenceState {
  return {
    expectedSeq,
    pending: [],
    gapDeadlineMs: null
  };
}

export function createTerminalSyncOutputState(): TerminalSyncOutputState {
  return {
    active: false,
    carry: new Uint8Array(),
    bufferedChunks: [],
    bufferedLength: 0
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

export function consumeTerminalSyncOutput(
  state: TerminalSyncOutputState,
  data: Uint8Array
): TerminalSyncOutputUpdate {
  const input =
    state.carry.length > 0
      ? concatUint8Arrays([state.carry, data], state.carry.length + data.length)
      : data;
  const ready: Uint8Array[] = [];
  let active = state.active;
  let bufferedChunks = [...state.bufferedChunks];
  let bufferedLength = state.bufferedLength;
  let cursor = 0;

  const emitReadyBytes = (bytes: Uint8Array) => {
    if (bytes.length > 0) {
      ready.push(bytes);
    }
  };

  const flushBufferedBytes = () => {
    if (bufferedLength <= 0) {
      return;
    }

    ready.push(concatUint8Arrays(bufferedChunks, bufferedLength));
    bufferedChunks = [];
    bufferedLength = 0;
  };

  const appendBufferedBytes = (bytes: Uint8Array) => {
    let offset = 0;

    while (offset < bytes.length) {
      const remainingBufferCapacity = MAX_SYNC_OUTPUT_BUFFER_BYTES - bufferedLength;

      if (remainingBufferCapacity <= 0) {
        flushBufferedBytes();
        continue;
      }

      const nextChunkLength = Math.min(remainingBufferCapacity, bytes.length - offset);
      const nextChunk = bytes.subarray(offset, offset + nextChunkLength);
      bufferedChunks.push(nextChunk);
      bufferedLength += nextChunk.length;
      offset += nextChunkLength;

      if (bufferedLength >= MAX_SYNC_OUTPUT_BUFFER_BYTES) {
        flushBufferedBytes();
      }
    }
  };

  while (cursor < input.length) {
    const sequence = active ? SYNC_OUTPUT_END_SEQUENCE : SYNC_OUTPUT_START_SEQUENCE;
    const sequenceIndex = findSequenceIndex(input, sequence, cursor);

    if (sequenceIndex === -1) {
      const remaining = input.subarray(cursor);
      const carryLength = getSequenceCarryLength(remaining, sequence);
      const readyLength = remaining.length - carryLength;

      if (readyLength > 0) {
        const nextBytes = remaining.subarray(0, readyLength);
        if (active) {
          appendBufferedBytes(nextBytes);
        } else {
          emitReadyBytes(nextBytes);
        }
      }

      return {
        state: {
          active,
          carry: carryLength > 0 ? remaining.slice(readyLength) : new Uint8Array(),
          bufferedChunks,
          bufferedLength
        },
        ready
      };
    }

    const nextBytes = input.subarray(cursor, sequenceIndex);
    if (nextBytes.length > 0) {
      if (active) {
        appendBufferedBytes(nextBytes);
      } else {
        emitReadyBytes(nextBytes);
      }
    }

    cursor = sequenceIndex + sequence.length;

    if (active) {
      flushBufferedBytes();

      active = false;
      continue;
    }

    active = true;
  }

  return {
    state: {
      active,
      carry: new Uint8Array(),
      bufferedChunks,
      bufferedLength
    },
    ready
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

export function getTerminalIdleThresholdMs(terminalMode: TerminalMode | null) {
  return terminalMode === "full_screen" ? FULL_SCREEN_TERMINAL_IDLE_MS : DEFAULT_TERMINAL_IDLE_MS;
}

export function getTerminalWriteFlushDelayMs(options: {
  terminalMode: TerminalMode | null;
  hasPtyWrite: boolean;
  ptyByteLength?: number;
}) {
  const { terminalMode, hasPtyWrite, ptyByteLength = 0 } = options;

  if (terminalMode === "full_screen" && hasPtyWrite) {
    if (ptyByteLength >= LARGE_FULL_SCREEN_PTY_WRITE_BYTES) {
      return FULL_SCREEN_LARGE_PTY_WRITE_FLUSH_DELAY_MS;
    }

    return FULL_SCREEN_PTY_WRITE_FLUSH_DELAY_MS;
  }

  return 0;
}

export function shouldForceTerminalResize(options: {
  pendingSinceMs: number | null;
  nowMs: number;
  maxDeferralMs?: number;
}) {
  const { pendingSinceMs, nowMs, maxDeferralMs = MAX_TERMINAL_RESIZE_DEFERRAL_MS } = options;

  if (pendingSinceMs === null) {
    return false;
  }

  return nowMs - pendingSinceMs >= maxDeferralMs;
}

export function getTerminalVisualResetReason(options: {
  previousSessionId: string | null;
  nextSessionId: string | null;
  clearSignalChanged: boolean;
}): TerminalVisualResetReason | null {
  if (options.clearSignalChanged) {
    return "clear_requested";
  }

  if (options.previousSessionId !== options.nextSessionId && options.nextSessionId !== null) {
    return "session_attached";
  }

  return null;
}
