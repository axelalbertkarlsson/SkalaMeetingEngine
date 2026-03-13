import { useEffect, useMemo, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";

const TERMINAL_CHUNK_EVENT = "codex://terminal-chunk";

interface TerminalChunkEventPayload {
  session_id: string;
  stream: CodexTerminalStream;
  chunk: string;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type CodexTerminalStream = "stdout" | "stderr" | "system";

export interface CodexTerminalEntry {
  sessionId: string;
  stream: CodexTerminalStream;
  chunk: string;
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

function formatEntry(entry: CodexTerminalEntry) {
  const rawChunk = entry.chunk;

  if (entry.stream === "system") {
    return `\x1b[90m${rawChunk}\x1b[0m`;
  }

  return rawChunk;
}

export function CodexTerminalPanel(props: CodexTerminalPanelProps) {
  const { session, entries, clearSignal, onStart, onStop, onClear, onSendInput, onResizeTerminal } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const renderedCountRef = useRef(0);
  const sessionStatusRef = useRef<CodexSessionStatus>(session.status);
  const sessionIdRef = useRef<string | null>(session.sessionId);
  const sendInputRef = useRef(onSendInput);
  const resizeTerminalRef = useRef(onResizeTerminal);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastHostPixelsRef = useRef<{ width: number; height: number } | null>(null);
  const writeQueueRef = useRef<string[]>([]);
  const isWritingRef = useRef(false);

  const canStart = session.status === "idle" || session.status === "stopped" || session.status === "error";
  const canStop = session.status === "running" || session.status === "starting";

  const flushWriteQueue = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      isWritingRef.current = false;
      writeQueueRef.current = [];
      return;
    }

    const nextChunk = writeQueueRef.current.shift();
    if (!nextChunk) {
      isWritingRef.current = false;
      return;
    }

    terminal.write(nextChunk, () => {
      flushWriteQueue();
    });
  };

  const enqueueWrite = (chunk: string) => {
    if (!chunk) {
      return;
    }

    writeQueueRef.current.push(chunk);
    if (isWritingRef.current) {
      return;
    }

    isWritingRef.current = true;
    flushWriteQueue();
  };

  useEffect(() => {
    sessionStatusRef.current = session.status;
  }, [session.status]);

  useEffect(() => {
    sessionIdRef.current = session.sessionId;
  }, [session.sessionId]);

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
      convertEol: true,
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

    const reportTerminalSize = () => {
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
    };

    const fitToHost = () => {
      const host = hostRef.current;
      if (!host) {
        return;
      }

      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width <= 0 || height <= 0) {
        return;
      }

      const lastPixels = lastHostPixelsRef.current;
      if (lastPixels && lastPixels.width === width && lastPixels.height === height) {
        return;
      }

      lastHostPixelsRef.current = { width, height };
      fitAddon.fit();
      reportTerminalSize();
    };

    fitToHost();

    terminalRef.current = terminal;

    const dataDisposable = terminal.onData((input) => {
      if (sessionStatusRef.current !== "running") {
        return;
      }

      // PTY-backed Codex expects raw key/input sequences, including control and arrow keys.
      sendInputRef.current(input);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitToHost();
    });
    resizeObserver.observe(hostRef.current);

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      renderedCountRef.current = 0;
      lastSizeRef.current = null;
      lastHostPixelsRef.current = null;
      writeQueueRef.current = [];
      isWritingRef.current = false;
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

          enqueueWrite(
            formatEntry({
              sessionId: event.payload.session_id,
              stream: event.payload.stream,
              chunk: event.payload.chunk
            })
          );
        });

        if (disposed && unlistenChunk) {
          unlistenChunk();
          unlistenChunk = null;
        }
      } catch (error) {
        enqueueWrite(`\n[system] Failed to register terminal chunk listener: ${String(error)}\n`);
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

    terminal.clear();
    terminal.reset();
    renderedCountRef.current = 0;
    writeQueueRef.current = [];
    isWritingRef.current = false;
  }, [clearSignal]);

  useEffect(() => {
    if (entries.length < renderedCountRef.current) {
      renderedCountRef.current = 0;
    }

    for (let index = renderedCountRef.current; index < entries.length; index += 1) {
      enqueueWrite(formatEntry(entries[index]));
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
