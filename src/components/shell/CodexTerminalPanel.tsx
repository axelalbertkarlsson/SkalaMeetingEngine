import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import {
  createTerminalSequenceState,
  decodeBase64ToUint8Array,
  encodeTextToBase64,
  enqueueTerminalWrite,
  flushTerminalWriteSequence,
  getTerminalResizeDelayMs,
  shouldDeferTerminalResize,
  type TerminalChunkEventPayload,
  type TerminalQueuedWrite
} from "./codexTerminalTransport";

const TERMINAL_CHUNK_EVENT = "codex://terminal-chunk";
const FIT_DEBOUNCE_MS = 120;
const CAPTURE_FLUSH_DELAY_MS = 100;
const CAPTURE_FLUSH_BATCH_SIZE = 50;

interface WindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

interface TerminalHostInfoResponse {
  windows_pty: {
    backend: "conpty" | "winpty";
    build_number?: number | null;
  } | null;
}

interface FrontendCaptureEvent {
  event_type: string;
  data: Record<string, unknown>;
}

function mapWindowsPtyInfo(hostInfo: TerminalHostInfoResponse): WindowsPtyInfo | null {
  const windowsPty = hostInfo.windows_pty;
  if (!windowsPty) {
    return null;
  }

  return {
    backend: windowsPty.backend,
    buildNumber: windowsPty.build_number ?? undefined
  };
}

type LocalTerminalWrite = {
  kind: "system_local";
  text: string;
};

type BufferedTerminalWrite = TerminalQueuedWrite | LocalTerminalWrite;

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
}

interface CodexTerminalPanelProps {
  session: CodexSessionState;
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

export function CodexTerminalPanel(props: CodexTerminalPanelProps) {
  const {
    session,
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
  const captureEnabledRef = useRef(captureEnabled);
  const sendInputRef = useRef(onSendInput);
  const resizeTerminalRef = useRef(onResizeTerminal);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastHostPixelsRef = useRef<{ width: number; height: number } | null>(null);
  const pendingHostPixelsRef = useRef<{ width: number; height: number } | null>(null);
  const writeQueueRef = useRef<BufferedTerminalWrite[]>([]);
  const isWriteFlushScheduledRef = useRef(false);
  const windowsPtyRef = useRef<WindowsPtyInfo | null>(
    typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")
      ? { backend: "conpty" }
      : null
  );
  const latestHostInfoRef = useRef<TerminalHostInfoResponse | null>(null);
  const sequenceStateRef = useRef(createTerminalSequenceState());
  const gapTimerRef = useRef<number | null>(null);
  const fitTimerRef = useRef<number | null>(null);
  const captureFlushTimerRef = useRef<number | null>(null);
  const captureQueueRef = useRef<FrontendCaptureEvent[]>([]);
  const captureFlushInFlightRef = useRef(false);
  const isTerminalFocusedRef = useRef(false);
  const lastInputAtRef = useRef<number | null>(null);

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

  const clearCaptureFlushTimer = () => {
    if (captureFlushTimerRef.current !== null) {
      window.clearTimeout(captureFlushTimerRef.current);
      captureFlushTimerRef.current = null;
    }
  };

  const resetTransportState = () => {
    sequenceStateRef.current = createTerminalSequenceState();
    clearGapTimer();
    writeQueueRef.current = [];
    isWriteFlushScheduledRef.current = false;
    pendingHostPixelsRef.current = null;
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

  const flushWriteQueue = () => {
    isWriteFlushScheduledRef.current = false;

    const terminal = terminalRef.current;
    if (!terminal) {
      writeQueueRef.current = [];
      return;
    }

    const pendingWrites = writeQueueRef.current.splice(0, writeQueueRef.current.length);
    if (pendingWrites.length === 0) {
      return;
    }

    let ptyChunkCount = 0;
    let ptyBytes = 0;
    let systemWriteCount = 0;

    for (const nextWrite of pendingWrites) {
      const payload = nextWrite.kind === "pty" ? nextWrite.data : formatSystemText(nextWrite.text);
      terminal.write(payload);

      if (nextWrite.kind === "pty") {
        ptyChunkCount += 1;
        ptyBytes += nextWrite.data.length;
      } else {
        systemWriteCount += 1;
      }
    }

    enqueueCaptureEvent("write_flushed", {
      queue_depth_before: pendingWrites.length,
      queue_depth_after: writeQueueRef.current.length,
      pty_chunk_count: ptyChunkCount,
      pty_bytes: ptyBytes,
      system_write_count: systemWriteCount
    });
  };

  const scheduleWriteFlush = () => {
    if (isWriteFlushScheduledRef.current) {
      return;
    }

    isWriteFlushScheduledRef.current = true;

    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => {
        flushWriteQueue();
      });
      return;
    }

    window.setTimeout(() => {
      flushWriteQueue();
    }, 0);
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
        enqueueCaptureEvent("sequence_gap_skipped", {
          from_seq: update.skippedRange.fromSeq,
          to_seq: update.skippedRange.toSeq,
          pending_count: update.state.pending.length
        });
      }

      for (const readyWrite of update.ready) {
        enqueueBufferedWrite(readyWrite);
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

    enqueueCaptureEvent("remote_chunk_received", {
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
      enqueueBufferedWrite(readyWrite);
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
    enqueueCaptureEvent("terminal_resize_reported", {
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
    if (
      shouldDeferTerminalResize({
        isFocused: isTerminalFocusedRef.current,
        lastInputAtMs: lastInputAtRef.current,
        nowMs
      })
    ) {
      const delayMs = getTerminalResizeDelayMs({
        lastInputAtMs: lastInputAtRef.current,
        nowMs
      });
      debugLog("fit-deferred", sessionIdRef.current, pendingHostPixels, "delayMs", delayMs);
      enqueueCaptureEvent("fit_deferred", {
        width: pendingHostPixels.width,
        height: pendingHostPixels.height,
        delay_ms: delayMs,
        focused: isTerminalFocusedRef.current
      });
      fitTimerRef.current = window.setTimeout(() => {
        applyFitIfReady();
      }, delayMs);
      return;
    }

    const lastAppliedPixels = lastHostPixelsRef.current;
    pendingHostPixelsRef.current = null;
    if (
      lastAppliedPixels &&
      lastAppliedPixels.width === pendingHostPixels.width &&
      lastAppliedPixels.height === pendingHostPixels.height
    ) {
      return;
    }

    lastHostPixelsRef.current = pendingHostPixels;
    fitAddon.fit();
    enqueueCaptureEvent("fit_applied", {
      width: pendingHostPixels.width,
      height: pendingHostPixels.height,
      cols: terminal.cols,
      rows: terminal.rows
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
    enqueueCaptureEvent("host_resize_observed", {
      width,
      height
    });
    scheduleFit();
  };

  useLayoutEffect(() => {
    sessionStatusRef.current = session.status;
  }, [session.status]);

  useLayoutEffect(() => {
    sessionIdRef.current = session.sessionId;
  }, [session.sessionId]);

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
    if (!hostRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: false,
      windowsPty: windowsPtyRef.current ?? undefined,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorWidth: 1,
      fontFamily: "IBM Plex Mono, Cascadia Mono, monospace",
      fontSize: 12,
      lineHeight: 1.3,
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

    if (windowsPtyRef.current) {
      terminal.options.windowsPty = windowsPtyRef.current;
    }

    queueFitToHost();

    const dataDisposable = terminal.onData((input) => {
      if (sessionStatusRef.current !== "running") {
        return;
      }

      lastInputAtRef.current = Date.now();
      enqueueCaptureEvent("input_sent", {
        byte_length: new TextEncoder().encode(input).length,
        input_base64: encodeTextToBase64(input)
      });
      sendInputRef.current(input);
    });

    const hostElement = hostRef.current;
    const handleFocusIn = () => {
      isTerminalFocusedRef.current = true;
      enqueueCaptureEvent("focus", {});
    };
    const handleFocusOut = () => {
      isTerminalFocusedRef.current = false;
      enqueueCaptureEvent("blur", {});
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
      hostElement.removeEventListener("focusin", handleFocusIn);
      hostElement.removeEventListener("focusout", handleFocusOut);
      resizeObserver.disconnect();
      clearGapTimer();
      clearFitTimer();
      clearCaptureFlushTimer();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      renderedCountRef.current = 0;
      lastSizeRef.current = null;
      lastHostPixelsRef.current = null;
      pendingHostPixelsRef.current = null;
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

    void invoke<TerminalHostInfoResponse>("get_terminal_host_info")
      .then((hostInfo) => {
        latestHostInfoRef.current = hostInfo;
        windowsPtyRef.current = mapWindowsPtyInfo(hostInfo) ?? windowsPtyRef.current;
        const terminal = terminalRef.current;
        if (terminal && windowsPtyRef.current) {
          terminal.options.windowsPty = windowsPtyRef.current;
          debugLog("windows-pty", windowsPtyRef.current);
        }

        enqueueCaptureEvent("terminal_host_info", {
          windows_pty: hostInfo.windows_pty
        });
      })
      .catch((error) => {
        debugLog("windows-pty-unavailable", error);
      });
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
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    enqueueCaptureEvent("terminal_reset", {
      reason: "clear_signal"
    });
    terminal.clear();
    terminal.reset();
    renderedCountRef.current = 0;
    resetTransportState();
  }, [clearSignal]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    resetCaptureQueue();
    terminal.clear();
    terminal.reset();
    renderedCountRef.current = 0;
    resetTransportState();
    lastHostPixelsRef.current = null;
    queueFitToHost();

    if (session.sessionId) {
      enqueueCaptureEvent("session_attached", {
        session_id: session.sessionId,
        status: session.status,
        windows_pty: latestHostInfoRef.current?.windows_pty ?? null
      });
    }
  }, [session.sessionId]);

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
          <span className="muted codex-terminal-message">{session.message}</span>
        </div>
      </header>

      <div className="codex-terminal-surface">
        <div ref={hostRef} className="codex-terminal-host" />
      </div>
    </section>
  );
}

