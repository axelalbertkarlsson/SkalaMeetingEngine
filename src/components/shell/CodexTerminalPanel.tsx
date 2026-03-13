import { useEffect, useMemo, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";

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
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onSendInput: (input: string) => void;
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
  const { session, entries, onStart, onStop, onClear, onSendInput } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const renderedCountRef = useRef(0);
  const inputBufferRef = useRef("");

  const canStart = session.status === "idle" || session.status === "stopped" || session.status === "error";
  const canStop = session.status === "running" || session.status === "starting";

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
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
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const dataDisposable = terminal.onData((input) => {
      if (session.status !== "running") {
        return;
      }

      if (input === "\r") {
        terminal.write("\r\n");
        const command = inputBufferRef.current;
        inputBufferRef.current = "";
        onSendInput(`${command}\n`);
        return;
      }

      if (input === "\u007F") {
        if (inputBufferRef.current.length === 0) {
          return;
        }

        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        terminal.write("\b \b");
        return;
      }

      if (input === "\u0003") {
        terminal.write("^C");
        inputBufferRef.current = "";
        onSendInput("\u0003");
        return;
      }

      if (input >= " ") {
        inputBufferRef.current += input;
        terminal.write(input);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(hostRef.current);

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      renderedCountRef.current = 0;
      inputBufferRef.current = "";
    };
  }, [onSendInput, session.status]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (entries.length < renderedCountRef.current) {
      terminal.clear();
      terminal.reset();
      renderedCountRef.current = 0;
    }

    for (let index = renderedCountRef.current; index < entries.length; index += 1) {
      terminal.write(formatEntry(entries[index]));
    }

    renderedCountRef.current = entries.length;
    fitAddonRef.current?.fit();
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
