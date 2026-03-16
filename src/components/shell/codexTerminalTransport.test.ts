import {
  createTerminalSequenceState,
  decodeBase64ToUint8Array,
  enqueueTerminalWrite,
  flushTerminalWriteSequence,
  getTerminalResizeDelayMs,
  shouldDeferTerminalResize,
  type TerminalQueuedWrite
} from "./codexTerminalTransport.js";

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
  }
];
