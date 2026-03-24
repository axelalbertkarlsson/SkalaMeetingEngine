import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import {
  consumeTerminalSyncOutput,
  createTerminalSyncOutputState,
  createTerminalSequenceState,
  decodeBase64ToUint8Array,
  encodeTextToBase64,
  enqueueTerminalWrite,
  flushTerminalWriteSequence,
  getTerminalIdleThresholdMs,
  getTerminalResizeDelayMs,
  getTerminalWriteFlushDelayMs,
  getTerminalVisualResetReason,
  shouldDeferTerminalResize,
  shouldForceTerminalResize,
  type TerminalMode,
  type TerminalChunkEventPayload,
  type TerminalQueuedWrite
} from "./codexTerminalTransport";

const TERMINAL_CHUNK_EVENT = "codex://terminal-chunk";
const FIT_DEBOUNCE_MS = 120;
const CAPTURE_FLUSH_DELAY_MS = 100;
const CAPTURE_FLUSH_BATCH_SIZE = 50;
const FULL_SCREEN_PTY_WRITE_MAX_HOLD_MS = 96;
const FULL_SCREEN_BACKSPACE_WRITE_DEBOUNCE_IDLE_MS = 150;
const FULL_SCREEN_BACKSPACE_WRITE_MAX_HOLD_MS = 160;

export interface WindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

export interface TerminalHostInfo {
  windowsPty: WindowsPtyInfo | null;
}

interface FrontendCaptureEvent {
  event_type: string;
  data: Record<string, unknown>;
}

type LocalTerminalWrite = {
  kind: "system_local";
  text: string;
};

type BufferedTerminalWrite = TerminalQueuedWrite | LocalTerminalWrite;

type CoalescedBufferedTerminalWrite =
  | {
      kind: "pty";
      chunks: Uint8Array[];
      byteLength: number;
      sourceCount: number;
    }
  | {
      kind: "system";
      text: string;
      sourceCount: number;
    };

type TerminalDensity = "comfortable" | "dense";

interface TerminalTypography {
  density: TerminalDensity;
  fontSize: number;
  lineHeight: number;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function debugLog(...args: unknown[]) {
  if (import.meta.env.DEV) {
    console.debug("[codex-terminal]", ...args);
  }
}

export interface CodexTerminalEntry {
  sessionId: string;
  text: string;
}

export type CodexSessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface CodexSessionState {
  sessionId: string | null;
  status: CodexSessionStatus;
  message: string;
  lastExitCode: number | null;
  terminalMode: TerminalMode | null;
  captureBundlePath: string | null;
  lastLifecyclePhase: string | null;
  lastResize: { cols: number; rows: number } | null;
}

interface CodexTerminalPanelProps {
  session: CodexSessionState;
  terminalHostInfo: TerminalHostInfo | null;
  entries: CodexTerminalEntry[];
  clearSignal: number;
  captureEnabled: boolean;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onSendInput: (input: string) => void;
  onResizeTerminal: (cols: number, rows: number) => void;
}

function statusLabel(session: CodexSessionState) {
  const base = session.status.toUpperCase();
  if (session.lastExitCode === null) {
    return base;
  }

  return `${base} (exit ${session.lastExitCode})`;
}

function formatSystemText(text: string) {
  return `\x1b[90m${text}\x1b[0m`;
}

function classifyInput(input: string) {
  if (input === " ") {
    return "space";
  }

  if (input === "\u007f" || input === "\b") {
    return "backspace";
  }

  if (input === "\r") {
    return "enter";
  }

  return "other";
}

function readTerminalSnapshot(terminal: Terminal | null, host: HTMLDivElement | null) {
  if (!terminal) {
    return {
      cols: null,
      rows: null,
      cursor_x: null,
      cursor_y: null,
      viewport_y: null,
      base_y: null,
      host_width: host?.clientWidth ?? null,
      host_height: host?.clientHeight ?? null,
      device_pixel_ratio: typeof window === "undefined" ? null : window.devicePixelRatio
    };
  }

  return {
    cols: terminal.cols,
    rows: terminal.rows,
    cursor_x: terminal.buffer.active.cursorX,
    cursor_y: terminal.buffer.active.cursorY,
    viewport_y: terminal.buffer.active.viewportY,
    base_y: terminal.buffer.active.baseY,
    host_width: host?.clientWidth ?? null,
    host_height: host?.clientHeight ?? null,
    device_pixel_ratio: typeof window === "undefined" ? null : window.devicePixelRatio
  };
}

function readTerminalLineContext(terminal: Terminal | null, radius = 1) {
  if (!terminal) {
    return [];
  }

  const activeBuffer = terminal.buffer.active;
  const startRow = Math.max(0, activeBuffer.cursorY - radius);
  const endRow = Math.min(terminal.rows - 1, activeBuffer.cursorY + radius);
  const lines: Array<{ row: number; text: string }> = [];

  for (let row = startRow; row <= endRow; row += 1) {
    const absoluteRow = activeBuffer.viewportY + row;
    const line = activeBuffer.getLine(absoluteRow);
    lines.push({
      row: absoluteRow,
      text: line?.translateToString(false, 0, terminal.cols) ?? ""
    });
  }

  return lines;
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

function getTerminalTypography(terminalMode: TerminalMode | null): TerminalTypography {
  if (terminalMode === "full_screen") {
    return {
      density: "dense",
      fontSize: 11,
      lineHeight: 1.1
    };
  }

  return {
    density: "comfortable",
    fontSize: 12,
    lineHeight: 1.3
  };
}

function coalesceBufferedWrites(writes: BufferedTerminalWrite[]) {
  const coalesced: CoalescedBufferedTerminalWrite[] = [];

  for (const nextWrite of writes) {
    const previousWrite = coalesced[coalesced.length - 1];

    if (nextWrite.kind === "pty") {
      if (previousWrite?.kind === "pty") {
        previousWrite.chunks.push(nextWrite.data);
        previousWrite.byteLength += nextWrite.data.length;
        previousWrite.sourceCount += 1;
        continue;
      }

      coalesced.push({
        kind: "pty",
        chunks: [nextWrite.data],
        byteLength: nextWrite.data.length,
        sourceCount: 1
      });
      continue;
    }

    if (previousWrite?.kind === "system") {
      previousWrite.text += nextWrite.text;
      previousWrite.sourceCount += 1;
      continue;
    }

    coalesced.push({
      kind: "system",
      text: nextWrite.text,
      sourceCount: 1
    });
  }

  return coalesced;
}

export function CodexTerminalPanel(props: CodexTerminalPanelProps) {
  const {
    session,
    terminalHostInfo,
    entries,
    clearSignal,
    captureEnabled,
    onStart,
    onStop,
    onClear,
    onSendInput,
    onResizeTerminal
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const renderedCountRef = useRef(0);
  const sessionStatusRef = useRef<CodexSessionStatus>(session.status);
  const sessionIdRef = useRef<string | null>(session.sessionId);
  const terminalModeRef = useRef<TerminalMode | null>(session.terminalMode);
  const terminalTypographyRef = useRef<TerminalTypography>(
    getTerminalTypography(session.terminalMode)
  );
  const captureEnabledRef = useRef(captureEnabled);
  const sendInputRef = useRef(onSendInput);
  const resizeTerminalRef = useRef(onResizeTerminal);
  const lastInputKindRef = useRef<ReturnType<typeof classifyInput> | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastHostPixelsRef = useRef<{ width: number; height: number } | null>(null);
  const pendingHostPixelsRef = useRef<{ width: number; height: number } | null>(null);
  const writeQueueRef = useRef<BufferedTerminalWrite[]>([]);
  const isWriteFlushScheduledRef = useRef(false);
  const writeFlushTimerRef = useRef<number | null>(null);
  const writeFlushFirstQueuedAtRef = useRef<number | null>(null);
  const writeFlushScheduledAtRef = useRef<number | null>(null);
  const writeFlushRequestedDelayRef = useRef(0);
  const paintRefreshFrameRef = useRef<number | null>(null);
  const windowsPtyRef = useRef<WindowsPtyInfo | null>(
    typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")
      ? { backend: "conpty" }
      : null
  );
  const sequenceStateRef = useRef(createTerminalSequenceState());
  const syncOutputStateRef = useRef(createTerminalSyncOutputState());
  const gapTimerRef = useRef<number | null>(null);
  const fitTimerRef = useRef<number | null>(null);
  const captureFlushTimerRef = useRef<number | null>(null);
  const captureQueueRef = useRef<FrontendCaptureEvent[]>([]);
  const captureFlushInFlightRef = useRef(false);
  const isTerminalFocusedRef = useRef(false);
  const lastInputAtRef = useRef<number | null>(null);
  const pendingResizeSinceRef = useRef<number | null>(null);
  const previousSessionIdRef = useRef<string | null>(session.sessionId);
  const previousClearSignalRef = useRef(clearSignal);

  const canStart = session.status === "idle" || session.status === "stopped" || session.status === "error";
  const canStop = session.status === "running" || session.status === "starting";

  const clearGapTimer = () => {
    if (gapTimerRef.current !== null) {
      window.clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
    }
  };

  const clearFitTimer = () => {
    if (fitTimerRef.current !== null) {
      window.clearTimeout(fitTimerRef.current);
      fitTimerRef.current = null;
    }
  };

  const clearWriteFlushTimer = () => {
    if (writeFlushTimerRef.current !== null) {
      window.clearTimeout(writeFlushTimerRef.current);
      writeFlushTimerRef.current = null;
    }

    writeFlushFirstQueuedAtRef.current = null;
    writeFlushScheduledAtRef.current = null;
    writeFlushRequestedDelayRef.current = 0;
  };

  const clearCaptureFlushTimer = () => {
    if (captureFlushTimerRef.current !== null) {
      window.clearTimeout(captureFlushTimerRef.current);
      captureFlushTimerRef.current = null;
    }
  };

  const clearPaintRefreshFrame = () => {
    if (paintRefreshFrameRef.current !== null) {
      window.cancelAnimationFrame(paintRefreshFrameRef.current);
      paintRefreshFrameRef.current = null;
    }
  };

  const resetTransportState = () => {
    sequenceStateRef.current = createTerminalSequenceState();
    syncOutputStateRef.current = createTerminalSyncOutputState();
    clearGapTimer();
    clearWriteFlushTimer();
    writeQueueRef.current = [];
    isWriteFlushScheduledRef.current = false;
    lastInputKindRef.current = null;
    pendingHostPixelsRef.current = null;
    pendingResizeSinceRef.current = null;
    lastInputAtRef.current = null;
  };

  const resetCaptureQueue = () => {
    clearCaptureFlushTimer();
    captureQueueRef.current = [];
    captureFlushInFlightRef.current = false;
  };

  const flushCaptureEvents = async () => {
    clearCaptureFlushTimer();

    if (captureFlushInFlightRef.current || !captureEnabledRef.current || !isTauriRuntime()) {
      return;
    }

    const sessionId = sessionIdRef.current;
    if (!sessionId || captureQueueRef.current.length === 0) {
      return;
    }

    captureFlushInFlightRef.current = true;
    const events = captureQueueRef.current.splice(0, captureQueueRef.current.length);

    try {
      await invoke("record_codex_capture_events", {
        request: {
          session_id: sessionId,
          events
        }
      });
    } catch (error) {
      debugLog("capture-flush-failed", sessionId, error);
    } finally {
      captureFlushInFlightRef.current = false;
      if (captureQueueRef.current.length > 0) {
        clearCaptureFlushTimer();
        captureFlushTimerRef.current = window.setTimeout(() => {
          void flushCaptureEvents();
        }, 0);
      }
    }
  };

  const scheduleCaptureFlush = (delayMs = CAPTURE_FLUSH_DELAY_MS) => {
    if (captureFlushTimerRef.current !== null) {
      return;
    }

    captureFlushTimerRef.current = window.setTimeout(() => {
      captureFlushTimerRef.current = null;
      void flushCaptureEvents();
    }, delayMs);
  };

  const enqueueCaptureEvent = (eventType: string, data: Record<string, unknown> = {}) => {
    if (!captureEnabledRef.current || !isTauriRuntime()) {
      return;
    }

    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return;
    }

    captureQueueRef.current.push({
      event_type: eventType,
      data
    });

    if (captureQueueRef.current.length >= CAPTURE_FLUSH_BATCH_SIZE) {
      void flushCaptureEvents();
      return;
    }

    scheduleCaptureFlush();
  };

  const scheduleTerminalPaintRefresh = (reason: string) => {
    if (windowsPtyRef.current === null || paintRefreshFrameRef.current !== null) {
      return;
    }

    paintRefreshFrameRef.current = window.requestAnimationFrame(() => {
      paintRefreshFrameRef.current = null;
      const terminal = terminalRef.current;
      if (!terminal || terminal.rows <= 0) {
        return;
      }

      terminal.refresh(0, terminal.rows - 1);
      const snapshot = readTerminalSnapshot(terminal, hostRef.current);
      enqueueCaptureEvent("frontend_terminal_refresh", {
        reason,
        cols: snapshot.cols,
        rows: snapshot.rows,
        cursor_x: snapshot.cursor_x,
        cursor_y: snapshot.cursor_y,
        viewport_y: snapshot.viewport_y,
        base_y: snapshot.base_y
      });
    });
  };

  const flushWriteQueue = () => {
    const scheduledAtMs = writeFlushScheduledAtRef.current;
    const requestedDelayMs = writeFlushRequestedDelayRef.current;
    clearWriteFlushTimer();
    isWriteFlushScheduledRef.current = false;

    const terminal = terminalRef.current;
    if (!terminal) {
      writeQueueRef.current = [];
      return;
    }

    const pendingWrites = writeQueueRef.current.splice(0, writeQueueRef.current.length);
    if (pendingWrites.length === 0) {
      writeFlushFirstQueuedAtRef.current = null;
      return;
    }

    writeFlushFirstQueuedAtRef.current = null;

    const coalescedWrites = coalesceBufferedWrites(pendingWrites);
    let ptyChunkCount = 0;
    let ptyBytes = 0;
    let systemWriteCount = 0;
    const snapshotBefore = readTerminalSnapshot(terminal, hostRef.current);
    const flushActualDelayMs =
      scheduledAtMs === null ? 0 : Math.max(0, Date.now() - scheduledAtMs);

    pendingWrites.forEach((nextWrite) => {
      if (nextWrite.kind === "pty") {
        ptyChunkCount += 1;
        ptyBytes += nextWrite.data.length;
        return;
      }

      systemWriteCount += 1;
    });

    coalescedWrites.forEach((nextWrite, index) => {
      const payload =
        nextWrite.kind === "pty"
          ? concatUint8Arrays(nextWrite.chunks, nextWrite.byteLength)
          : formatSystemText(nextWrite.text);

      terminal.write(payload, index === coalescedWrites.length - 1
        ? () => {
            const snapshotAfter = readTerminalSnapshot(terminalRef.current, hostRef.current);
            const lineContextAfter = readTerminalLineContext(terminalRef.current);
            enqueueCaptureEvent("frontend_write_applied", {
              queue_depth_before: pendingWrites.length,
              queue_depth_after: writeQueueRef.current.length,
              pty_chunk_count: ptyChunkCount,
              pty_bytes: ptyBytes,
              system_write_count: systemWriteCount,
              terminal_write_calls: coalescedWrites.length,
              coalesced_write_count: pendingWrites.length - coalescedWrites.length,
              requested_flush_delay_ms: requestedDelayMs,
              actual_flush_delay_ms: flushActualDelayMs,
              forced_refresh: false,
              before_cols: snapshotBefore.cols,
              before_rows: snapshotBefore.rows,
              before_cursor_x: snapshotBefore.cursor_x,
              before_cursor_y: snapshotBefore.cursor_y,
              before_viewport_y: snapshotBefore.viewport_y,
              before_base_y: snapshotBefore.base_y,
              after_cols: snapshotAfter.cols,
              after_rows: snapshotAfter.rows,
              after_cursor_x: snapshotAfter.cursor_x,
              after_cursor_y: snapshotAfter.cursor_y,
              after_viewport_y: snapshotAfter.viewport_y,
              after_base_y: snapshotAfter.base_y,
              after_line_context: lineContextAfter
            });
          }
        : undefined);
    });

    enqueueCaptureEvent("frontend_write_flushed", {
      queue_depth_before: pendingWrites.length,
      queue_depth_after: writeQueueRef.current.length,
      pty_chunk_count: ptyChunkCount,
      pty_bytes: ptyBytes,
      system_write_count: systemWriteCount,
      terminal_write_calls: coalescedWrites.length,
      coalesced_write_count: pendingWrites.length - coalescedWrites.length,
      requested_flush_delay_ms: requestedDelayMs,
      actual_flush_delay_ms: flushActualDelayMs,
      cols: snapshotBefore.cols,
      rows: snapshotBefore.rows,
      cursor_x: snapshotBefore.cursor_x,
      cursor_y: snapshotBefore.cursor_y,
      viewport_y: snapshotBefore.viewport_y,
      base_y: snapshotBefore.base_y,
      host_width: snapshotBefore.host_width,
      host_height: snapshotBefore.host_height,
      device_pixel_ratio: snapshotBefore.device_pixel_ratio
    });
  };

  const scheduleWriteFlush = () => {
    const nowMs = Date.now();
    const ptyByteLength = writeQueueRef.current.reduce((total, entry) => {
      if (entry.kind !== "pty") {
        return total;
      }

      return total + entry.data.length;
    }, 0);
    const hasPtyWrite = ptyByteLength > 0;
    const currentTerminalMode = terminalModeRef.current;
    const delayMs = getTerminalWriteFlushDelayMs({
      terminalMode: currentTerminalMode,
      hasPtyWrite,
      ptyByteLength
    });
    const shouldDebounceForBackspace =
      currentTerminalMode === "full_screen"
      && hasPtyWrite
      && lastInputKindRef.current === "backspace"
      && lastInputAtRef.current !== null
      && nowMs - lastInputAtRef.current <= FULL_SCREEN_BACKSPACE_WRITE_DEBOUNCE_IDLE_MS;
    const shouldRescheduleForFullScreenPty =
      currentTerminalMode === "full_screen" && hasPtyWrite;

    if (isWriteFlushScheduledRef.current) {
      if (!shouldDebounceForBackspace && !shouldRescheduleForFullScreenPty) {
        return;
      }

      const firstQueuedAtMs = writeFlushFirstQueuedAtRef.current ?? nowMs;
      const maxHoldMs = shouldDebounceForBackspace
        ? FULL_SCREEN_BACKSPACE_WRITE_MAX_HOLD_MS
        : FULL_SCREEN_PTY_WRITE_MAX_HOLD_MS;
      const remainingMaxDelayMs = Math.max(
        0,
        maxHoldMs - (nowMs - firstQueuedAtMs)
      );
      const nextDelayMs = Math.min(delayMs, remainingMaxDelayMs);
      const shouldExtendScheduledFlush =
        shouldDebounceForBackspace || nextDelayMs > writeFlushRequestedDelayRef.current;

      if (!shouldExtendScheduledFlush) {
        return;
      }

      if (writeFlushTimerRef.current !== null) {
        window.clearTimeout(writeFlushTimerRef.current);
        writeFlushTimerRef.current = null;
      }

      writeFlushScheduledAtRef.current = nowMs;
      writeFlushRequestedDelayRef.current = nextDelayMs;
      enqueueCaptureEvent("frontend_write_flush_rescheduled", {
        reason: shouldDebounceForBackspace
          ? "recent_backspace_input"
          : "full_screen_pty_batching",
        delay_ms: nextDelayMs,
        remaining_max_delay_ms: remainingMaxDelayMs,
        queue_depth: writeQueueRef.current.length,
        pty_bytes: ptyByteLength
      });

      if (nextDelayMs <= 0 && typeof queueMicrotask === "function") {
        queueMicrotask(() => {
          flushWriteQueue();
        });
        return;
      }

      writeFlushTimerRef.current = window.setTimeout(() => {
        writeFlushTimerRef.current = null;
        flushWriteQueue();
      }, nextDelayMs);
      return;
    }

    isWriteFlushScheduledRef.current = true;
    if (writeFlushFirstQueuedAtRef.current === null) {
      writeFlushFirstQueuedAtRef.current = nowMs;
    }
    writeFlushScheduledAtRef.current = nowMs;
    writeFlushRequestedDelayRef.current = delayMs;

    if (delayMs <= 0 && typeof queueMicrotask === "function") {
      queueMicrotask(() => {
        flushWriteQueue();
      });
      return;
    }

    writeFlushTimerRef.current = window.setTimeout(() => {
      writeFlushTimerRef.current = null;
      flushWriteQueue();
    }, delayMs);
  };

  const enqueueBufferedWrite = (write: BufferedTerminalWrite) => {
    if (write.kind !== "pty" && !write.text) {
      return;
    }

    if (write.kind === "pty" && write.data.length === 0) {
      return;
    }

    writeQueueRef.current.push(write);
    debugLog(
      "write-enqueued",
      sessionIdRef.current,
      write.kind === "pty"
        ? { kind: write.kind, seq: write.seq, bytes: write.data.length }
        : { kind: write.kind },
      "queueDepth",
      writeQueueRef.current.length
    );

    scheduleWriteFlush();
  };

  const enqueueReadyWrite = (write: TerminalQueuedWrite) => {
    if (write.kind !== "pty") {
      enqueueBufferedWrite(write);
      return;
    }

    const syncOutputUpdate = consumeTerminalSyncOutput(syncOutputStateRef.current, write.data);
    syncOutputStateRef.current = syncOutputUpdate.state;

    if (syncOutputUpdate.ready.length > 1) {
      enqueueCaptureEvent("frontend_sync_output_flushed", {
        emitted_chunk_count: syncOutputUpdate.ready.length,
        emitted_byte_length: syncOutputUpdate.ready.reduce(
          (total, chunk) => total + chunk.length,
          0
        )
      });
    }

    for (const nextChunk of syncOutputUpdate.ready) {
      enqueueBufferedWrite({
        kind: "pty",
        seq: write.seq,
        data: nextChunk
      });
    }
  };

  const scheduleGapFlush = () => {
    clearGapTimer();

    const gapDeadlineMs = sequenceStateRef.current.gapDeadlineMs;
    if (gapDeadlineMs === null) {
      return;
    }

    const delayMs = Math.max(0, gapDeadlineMs - Date.now());
    gapTimerRef.current = window.setTimeout(() => {
      gapTimerRef.current = null;
      const update = flushTerminalWriteSequence(sequenceStateRef.current, Date.now());
      sequenceStateRef.current = update.state;

      if (update.skippedRange) {
        debugLog("sequence-gap-skipped", sessionIdRef.current, update.skippedRange);
        enqueueCaptureEvent("frontend_sequence_gap_skipped", {
          from_seq: update.skippedRange.fromSeq,
          to_seq: update.skippedRange.toSeq,
          pending_count: update.state.pending.length
        });
      }

      for (const readyWrite of update.ready) {
        enqueueReadyWrite(readyWrite);
      }

      scheduleGapFlush();
    }, delayMs);
  };

  const handleRemoteChunk = (payload: TerminalChunkEventPayload) => {
    const nextWrite: TerminalQueuedWrite =
      payload.kind === "pty"
        ? {
            kind: "pty",
            seq: payload.seq,
            data: decodeBase64ToUint8Array(payload.data_base64)
          }
        : {
            kind: "system",
            seq: payload.seq,
            text: payload.text
          };

    const update = enqueueTerminalWrite(sequenceStateRef.current, nextWrite, Date.now());
    sequenceStateRef.current = update.state;
    const writeSize = nextWrite.kind === "pty" ? nextWrite.data.length : nextWrite.text.length;

    enqueueCaptureEvent("frontend_remote_chunk_received", {
      seq: payload.seq,
      kind: payload.kind,
      size: writeSize,
      pending_count: update.state.pending.length,
      expected_seq: update.state.expectedSeq
    });

    debugLog(
      "remote-chunk",
      payload.session_id,
      payload.kind,
      payload.seq,
      writeSize,
      "pending",
      update.state.pending.length
    );

    for (const readyWrite of update.ready) {
      enqueueReadyWrite(readyWrite);
    }

    scheduleGapFlush();
  };

  const reportTerminalSize = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const cols = terminal.cols;
    const rows = terminal.rows;
    if (cols <= 0 || rows <= 0) {
      return;
    }

    const last = lastSizeRef.current;
    if (last && last.cols === cols && last.rows === rows) {
      return;
    }

    lastSizeRef.current = { cols, rows };
    resizeTerminalRef.current(cols, rows);
    enqueueCaptureEvent("frontend_terminal_resize_reported", {
      cols,
      rows
    });
  };

  const applyFitIfReady = () => {
    clearFitTimer();

    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const pendingHostPixels = pendingHostPixelsRef.current;
    if (!terminal || !fitAddon || !pendingHostPixels) {
      return;
    }

    const nowMs = Date.now();
    const currentTerminalMode = terminalModeRef.current;
    const idleThresholdMs = getTerminalIdleThresholdMs(currentTerminalMode);
    const snapshotBeforeFit = readTerminalSnapshot(terminal, hostRef.current);
    enqueueCaptureEvent("frontend_fit_requested", {
      width: pendingHostPixels.width,
      height: pendingHostPixels.height,
      terminal_mode: currentTerminalMode,
      idle_threshold_ms: idleThresholdMs,
      cols: snapshotBeforeFit.cols,
      rows: snapshotBeforeFit.rows,
      cursor_x: snapshotBeforeFit.cursor_x,
      cursor_y: snapshotBeforeFit.cursor_y,
      viewport_y: snapshotBeforeFit.viewport_y,
      base_y: snapshotBeforeFit.base_y
    });

    if (
      shouldDeferTerminalResize({
        isFocused: isTerminalFocusedRef.current,
        lastInputAtMs: lastInputAtRef.current,
        nowMs,
        idleThresholdMs
      })
      && !shouldForceTerminalResize({
        pendingSinceMs: pendingResizeSinceRef.current,
        nowMs
      })
    ) {
      const delayMs = getTerminalResizeDelayMs({
        lastInputAtMs: lastInputAtRef.current,
        nowMs,
        idleThresholdMs
      });
      debugLog("fit-deferred", sessionIdRef.current, pendingHostPixels, "delayMs", delayMs);
      enqueueCaptureEvent("frontend_fit_deferred", {
        width: pendingHostPixels.width,
        height: pendingHostPixels.height,
        delay_ms: delayMs,
        focused: isTerminalFocusedRef.current,
        cols: snapshotBeforeFit.cols,
        rows: snapshotBeforeFit.rows,
        cursor_x: snapshotBeforeFit.cursor_x,
        cursor_y: snapshotBeforeFit.cursor_y
      });
      fitTimerRef.current = window.setTimeout(() => {
        applyFitIfReady();
      }, delayMs);
      return;
    }

    const lastAppliedPixels = lastHostPixelsRef.current;
    pendingHostPixelsRef.current = null;
    pendingResizeSinceRef.current = null;
    if (
      lastAppliedPixels &&
      lastAppliedPixels.width === pendingHostPixels.width &&
      lastAppliedPixels.height === pendingHostPixels.height
    ) {
      return;
    }

    lastHostPixelsRef.current = pendingHostPixels;
    fitAddon.fit();
    scheduleTerminalPaintRefresh("fit_applied");
    const snapshotAfterFit = readTerminalSnapshot(terminal, hostRef.current);
    enqueueCaptureEvent("frontend_fit_applied", {
      width: pendingHostPixels.width,
      height: pendingHostPixels.height,
      cols: terminal.cols,
      rows: terminal.rows,
      before_cursor_x: snapshotBeforeFit.cursor_x,
      before_cursor_y: snapshotBeforeFit.cursor_y,
      after_cursor_x: snapshotAfterFit.cursor_x,
      after_cursor_y: snapshotAfterFit.cursor_y
    });
    reportTerminalSize();
  };

  const scheduleFit = (delayMs = FIT_DEBOUNCE_MS) => {
    clearFitTimer();
    fitTimerRef.current = window.setTimeout(() => {
      applyFitIfReady();
    }, delayMs);
  };

  const queueFitToHost = () => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width <= 0 || height <= 0) {
      return;
    }

    pendingHostPixelsRef.current = { width, height };
    if (pendingResizeSinceRef.current === null) {
      pendingResizeSinceRef.current = Date.now();
    }

    enqueueCaptureEvent("frontend_host_resize_observed", {
      width,
      height
    });
    scheduleFit();
  };

  const applyTerminalTypography = (terminalMode: TerminalMode | null) => {
    const terminal = terminalRef.current;
    const nextTypography = getTerminalTypography(terminalMode);
    const previousTypography = terminalTypographyRef.current;
    terminalTypographyRef.current = nextTypography;

    if (!terminal) {
      return;
    }

    const fontSizeChanged = terminal.options.fontSize !== nextTypography.fontSize;
    const lineHeightChanged = terminal.options.lineHeight !== nextTypography.lineHeight;
    if (!fontSizeChanged && !lineHeightChanged) {
      return;
    }

    terminal.options.fontSize = nextTypography.fontSize;
    terminal.options.lineHeight = nextTypography.lineHeight;
    lastHostPixelsRef.current = null;
    enqueueCaptureEvent("frontend_terminal_typography_updated", {
      terminal_mode: terminalMode,
      previous_density: previousTypography.density,
      density: nextTypography.density,
      font_size: nextTypography.fontSize,
      line_height: nextTypography.lineHeight
    });
    queueFitToHost();
  };

  useLayoutEffect(() => {
    sessionStatusRef.current = session.status;
  }, [session.status]);

  useLayoutEffect(() => {
    sessionIdRef.current = session.sessionId;
  }, [session.sessionId]);

  useLayoutEffect(() => {
    terminalModeRef.current = session.terminalMode;
  }, [session.terminalMode]);

  useLayoutEffect(() => {
    windowsPtyRef.current = terminalHostInfo?.windowsPty ?? windowsPtyRef.current;
  }, [terminalHostInfo]);

  useEffect(() => {
    captureEnabledRef.current = captureEnabled;
    if (!captureEnabled) {
      resetCaptureQueue();
    }
  }, [captureEnabled]);

  useEffect(() => {
    sendInputRef.current = onSendInput;
  }, [onSendInput]);

  useEffect(() => {
    resizeTerminalRef.current = onResizeTerminal;
  }, [onResizeTerminal]);

  useEffect(() => {
    applyTerminalTypography(session.terminalMode);
  }, [session.terminalMode]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const initialTypography = getTerminalTypography(session.terminalMode);
    terminalTypographyRef.current = initialTypography;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorWidth: 1,
      fontFamily: "IBM Plex Mono, Cascadia Mono, monospace",
      fontSize: initialTypography.fontSize,
      lineHeight: initialTypography.lineHeight,
      theme: {
        background: "#171b22",
        foreground: "#dbe2ef"
      }
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    queueFitToHost();

    const dataDisposable = terminal.onData((input) => {
      if (sessionStatusRef.current !== "running") {
        return;
      }

      const inputKind = classifyInput(input);
      lastInputAtRef.current = Date.now();
      lastInputKindRef.current = inputKind;
      const snapshot = readTerminalSnapshot(terminalRef.current, hostRef.current);
      enqueueCaptureEvent("frontend_input_sent", {
        input_kind: inputKind,
        byte_length: new TextEncoder().encode(input).length,
        input_base64: encodeTextToBase64(input),
        cols: snapshot.cols,
        rows: snapshot.rows,
        cursor_x: snapshot.cursor_x,
        cursor_y: snapshot.cursor_y,
        viewport_y: snapshot.viewport_y,
        base_y: snapshot.base_y,
        host_width: snapshot.host_width,
        host_height: snapshot.host_height
      });
      sendInputRef.current(input);
    });

    const resizeDisposable = terminal.onResize((size) => {
      const snapshot = readTerminalSnapshot(terminalRef.current, hostRef.current);
      enqueueCaptureEvent("frontend_xterm_resized", {
        cols: size.cols,
        rows: size.rows,
        cursor_x: snapshot.cursor_x,
        cursor_y: snapshot.cursor_y,
        viewport_y: snapshot.viewport_y,
        base_y: snapshot.base_y,
        host_width: snapshot.host_width,
        host_height: snapshot.host_height,
        device_pixel_ratio: snapshot.device_pixel_ratio
      });
    });

    const hostElement = hostRef.current;
    const handleFocusIn = () => {
      isTerminalFocusedRef.current = true;
      enqueueCaptureEvent("frontend_focus_changed", {
        focused: true
      });
    };
    const handleFocusOut = () => {
      isTerminalFocusedRef.current = false;
      enqueueCaptureEvent("frontend_focus_changed", {
        focused: false
      });
      scheduleFit(0);
    };

    hostElement.addEventListener("focusin", handleFocusIn);
    hostElement.addEventListener("focusout", handleFocusOut);

    const resizeObserver = new ResizeObserver(() => {
      queueFitToHost();
    });
    resizeObserver.observe(hostElement);

    return () => {
      dataDisposable.dispose();
      resizeDisposable.dispose();
      hostElement.removeEventListener("focusin", handleFocusIn);
      hostElement.removeEventListener("focusout", handleFocusOut);
      resizeObserver.disconnect();
      clearGapTimer();
      clearFitTimer();
      clearWriteFlushTimer();
      clearCaptureFlushTimer();
      clearPaintRefreshFrame();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      renderedCountRef.current = 0;
      lastSizeRef.current = null;
      lastHostPixelsRef.current = null;
      pendingHostPixelsRef.current = null;
      pendingResizeSinceRef.current = null;
      writeQueueRef.current = [];
      isWriteFlushScheduledRef.current = false;
      captureQueueRef.current = [];
      captureFlushInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlistenChunk: UnlistenFn | null = null;
    let disposed = false;

    const attach = async () => {
      try {
        unlistenChunk = await listen<TerminalChunkEventPayload>(TERMINAL_CHUNK_EVENT, (event) => {
          const currentSessionId = sessionIdRef.current;
          if (currentSessionId && event.payload.session_id !== currentSessionId) {
            return;
          }

          handleRemoteChunk(event.payload);
        });

        if (disposed && unlistenChunk) {
          unlistenChunk();
          unlistenChunk = null;
        }
      } catch (error) {
        enqueueBufferedWrite({
          kind: "system_local",
          text: `\n[system] Failed to register terminal chunk listener: ${String(error)}\n`
        });
      }
    };

    void attach();

    return () => {
      disposed = true;
      if (unlistenChunk) {
        unlistenChunk();
      }
    };
  }, []);

  useEffect(() => {
    enqueueCaptureEvent("frontend_terminal_host_info", {
      windows_pty: terminalHostInfo?.windowsPty ?? null,
      windows_pty_applied: false
    });
  }, [terminalHostInfo]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const resetReason = getTerminalVisualResetReason({
      previousSessionId: previousSessionIdRef.current,
      nextSessionId: session.sessionId,
      clearSignalChanged: clearSignal !== previousClearSignalRef.current
    });

    previousSessionIdRef.current = session.sessionId;
    previousClearSignalRef.current = clearSignal;

    if (!resetReason) {
      return;
    }

    if (resetReason === "session_attached") {
      resetCaptureQueue();
    }

    enqueueCaptureEvent("frontend_terminal_reset", {
      reason: resetReason,
      session_id: session.sessionId,
      terminal_mode: session.terminalMode,
      windows_pty: terminalHostInfo?.windowsPty ?? null
    });
    terminal.clear();
    terminal.reset();
    scheduleTerminalPaintRefresh("terminal_reset");
    renderedCountRef.current = 0;
    resetTransportState();
    lastHostPixelsRef.current = null;
    queueFitToHost();

    if (resetReason === "session_attached" && session.sessionId) {
      enqueueCaptureEvent("frontend_session_attached", {
        session_id: session.sessionId,
        status: session.status,
        terminal_mode: session.terminalMode,
        windows_pty: terminalHostInfo?.windowsPty ?? null
      });
    }
  }, [clearSignal, session.sessionId, session.status, session.terminalMode, terminalHostInfo]);

  useEffect(() => {
    if (entries.length < renderedCountRef.current) {
      renderedCountRef.current = 0;
    }

    for (let index = renderedCountRef.current; index < entries.length; index += 1) {
      enqueueBufferedWrite({
        kind: "system_local",
        text: entries[index].text
      });
    }

    renderedCountRef.current = entries.length;
  }, [entries]);

  const statusToneClass = useMemo(() => {
    if (session.status === "running") {
      return "tone-success";
    }

    if (session.status === "error") {
      return "tone-danger";
    }

    if (session.status === "starting" || session.status === "stopping") {
      return "tone-warning";
    }

    return "tone-neutral";
  }, [session.status]);

  const terminalDensity = session.terminalMode === "full_screen" ? "dense" : "comfortable";

  return (
    <section className="codex-terminal-panel" aria-label="Codex terminal">
      <header className="codex-terminal-toolbar">
        <div className="codex-terminal-toolbar-group">
          <button type="button" className="codex-terminal-button" disabled={!canStart} onClick={onStart}>
            Start
          </button>
          <button type="button" className="codex-terminal-button" disabled={!canStop} onClick={onStop}>
            Stop
          </button>
          <button type="button" className="codex-terminal-button" onClick={onClear}>
            Clear
          </button>
        </div>

        <div className="codex-terminal-toolbar-group">
          <span className={`codex-terminal-status ${statusToneClass}`}>{statusLabel(session)}</span>
        </div>
      </header>

      <div className="codex-terminal-surface" data-density={terminalDensity}>
        <div ref={hostRef} className="codex-terminal-host" data-density={terminalDensity} />
      </div>
    </section>
  );
}

