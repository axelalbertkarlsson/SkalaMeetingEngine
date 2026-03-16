import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import { decodeBase64ToUint8Array } from "../components/shell/codexTerminalTransport";
import { PaneHeader } from "../components/shell/PaneHeader";
import type { Workspace } from "../models/workspace";

interface CodexScreenProps {
  workspace: Workspace;
}

interface CaptureBundleListItem {
  path: string;
  session_id: string;
  created_at_ms: number;
  command_line: string;
}

interface CaptureBundleManifest {
  session_id: string;
  workspace_path: string;
  command_line: string;
  created_at_ms: number;
  args: string[];
  terminal_host: {
    windows_pty?: {
      backend: "conpty" | "winpty";
      build_number?: number | null;
    } | null;
  };
}

interface ReplayPtyChunk {
  kind: "pty";
  seq: number;
  timestamp_ms: number;
  data_base64: string;
}

interface ReplaySystemChunk {
  kind: "system";
  seq: number;
  timestamp_ms: number;
  text: string;
}

type ReplayChunk = ReplayPtyChunk | ReplaySystemChunk;

interface LoadCaptureBundleResponse {
  manifest: CaptureBundleManifest;
  chunks: ReplayChunk[];
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function formatDateTime(timestampMs: number) {
  return new Date(timestampMs).toLocaleString();
}

function writeReplayChunk(terminal: Terminal, chunk: ReplayChunk) {
  if (chunk.kind === "pty") {
    terminal.write(decodeBase64ToUint8Array(chunk.data_base64));
    return;
  }

  terminal.write(chunk.text);
}

export function CodexScreen({ workspace }: CodexScreenProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const replayTimerIdsRef = useRef<number[]>([]);
  const replayRunIdRef = useRef(0);

  const [bundles, setBundles] = useState<CaptureBundleListItem[]>([]);
  const [bundlePath, setBundlePath] = useState("");
  const [loadedBundle, setLoadedBundle] = useState<LoadCaptureBundleResponse | null>(null);
  const [loadingBundles, setLoadingBundles] = useState(false);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [replayTrigger, setReplayTrigger] = useState(0);
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const [replayStatus, setReplayStatus] = useState("Load a capture bundle to replay the PTY stream.");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [useRecordedTiming, setUseRecordedTiming] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState("1");
  const [convertEol, setConvertEol] = useState(false);
  const [useWindowsPty, setUseWindowsPty] = useState(true);

  const recentBundleOptions = useMemo(
    () => bundles.map((bundle) => ({ ...bundle, label: `${formatDateTime(bundle.created_at_ms)} - ${bundle.session_id}` })),
    [bundles]
  );

  const replaySummary = useMemo(() => {
    if (!loadedBundle || loadedBundle.chunks.length === 0) {
      return null;
    }

    const firstTimestamp = loadedBundle.chunks[0].timestamp_ms;
    const lastTimestamp = loadedBundle.chunks[loadedBundle.chunks.length - 1].timestamp_ms;
    const ptyChunkCount = loadedBundle.chunks.filter((chunk) => chunk.kind === "pty").length;
    const systemChunkCount = loadedBundle.chunks.length - ptyChunkCount;

    return {
      firstTimestamp,
      lastTimestamp,
      durationMs: Math.max(0, lastTimestamp - firstTimestamp),
      ptyChunkCount,
      systemChunkCount
    };
  }, [loadedBundle]);

  const clearReplayTimers = () => {
    for (const timerId of replayTimerIdsRef.current) {
      window.clearTimeout(timerId);
    }
    replayTimerIdsRef.current = [];
  };

  const stopReplay = (status = "Replay stopped.") => {
    replayRunIdRef.current += 1;
    clearReplayTimers();
    setIsPlaying(false);
    setReplayStatus(status);
  };

  const refreshBundles = async () => {
    if (!isTauriRuntime()) {
      setErrorMessage("Capture replay is only available inside the Tauri app.");
      return;
    }

    setLoadingBundles(true);
    setErrorMessage(null);

    try {
      const response = await invoke<CaptureBundleListItem[]>("list_codex_capture_bundles", {
        request: {
          workspace_path: workspace.rootPath
        }
      });

      setBundles(response);
      setBundlePath((current) => current || response[0]?.path || "");
    } catch (error) {
      setErrorMessage(`Failed to list capture bundles: ${String(error)}`);
    } finally {
      setLoadingBundles(false);
    }
  };

  const loadBundle = async () => {
    if (!bundlePath.trim()) {
      setErrorMessage("Enter a capture bundle path first.");
      return;
    }

    if (!isTauriRuntime()) {
      setErrorMessage("Capture replay is only available inside the Tauri app.");
      return;
    }

    setLoadingBundle(true);
    setErrorMessage(null);

    try {
      const response = await invoke<LoadCaptureBundleResponse>("load_codex_capture_bundle", {
        request: {
          bundle_path: bundlePath.trim()
        }
      });

      setLoadedBundle(response);
      setUseWindowsPty(Boolean(response.manifest.terminal_host?.windows_pty));
      setReplayStatus(`Loaded ${response.chunks.length} terminal chunks from ${response.manifest.session_id}.`);
      setReplayTrigger((current) => current + 1);
    } catch (error) {
      setErrorMessage(`Failed to load capture bundle: ${String(error)}`);
    } finally {
      setLoadingBundle(false);
    }
  };

  useEffect(() => {
    void refreshBundles();
  }, [workspace.rootPath]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      convertEol,
      windowsPty: useWindowsPty
        ? {
            backend: loadedBundle?.manifest.terminal_host?.windows_pty?.backend ?? "conpty",
            buildNumber: loadedBundle?.manifest.terminal_host?.windows_pty?.build_number ?? undefined
          }
        : undefined,
      disableStdin: true,
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
    terminal.open(host);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setTerminalGeneration((current) => current + 1);

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      clearReplayTimers();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [convertEol, loadedBundle?.manifest.terminal_host?.windows_pty?.backend, loadedBundle?.manifest.terminal_host?.windows_pty?.build_number, useWindowsPty]);

  useEffect(() => {
    if (!loadedBundle || !terminalRef.current) {
      return;
    }

    const terminal = terminalRef.current;
    const replayRunId = replayRunIdRef.current + 1;
    replayRunIdRef.current = replayRunId;
    clearReplayTimers();
    terminal.clear();
    terminal.reset();
    fitAddonRef.current?.fit();

    if (loadedBundle.chunks.length === 0) {
      setIsPlaying(false);
      setReplayStatus("Capture bundle does not contain terminal chunks.");
      return;
    }

    const finishReplay = () => {
      if (replayRunIdRef.current !== replayRunId) {
        return;
      }

      setIsPlaying(false);
      setReplayStatus(`Replay complete. Rendered ${loadedBundle.chunks.length} chunks.`);
    };

    setIsPlaying(true);
    setReplayStatus(`Replaying ${loadedBundle.chunks.length} chunks from ${loadedBundle.manifest.session_id}...`);

    if (!useRecordedTiming) {
      for (const chunk of loadedBundle.chunks) {
        writeReplayChunk(terminal, chunk);
      }
      finishReplay();
      return;
    }

    const speed = Math.max(0.25, Number(playbackSpeed) || 1);
    const firstTimestamp = loadedBundle.chunks[0].timestamp_ms;

    loadedBundle.chunks.forEach((chunk, index) => {
      const delayMs = Math.max(0, Math.round((chunk.timestamp_ms - firstTimestamp) / speed));
      const timerId = window.setTimeout(() => {
        if (replayRunIdRef.current !== replayRunId || !terminalRef.current) {
          return;
        }

        writeReplayChunk(terminalRef.current, chunk);
        if (index === loadedBundle.chunks.length - 1) {
          finishReplay();
        }
      }, delayMs);

      replayTimerIdsRef.current.push(timerId);
    });
  }, [loadedBundle, playbackSpeed, replayTrigger, terminalGeneration, useRecordedTiming]);

  return (
    <section className="workspace-screen">
      <PaneHeader
        eyebrow="Codex"
        title="Capture Replay Harness"
        subtitle="Replay backend PTY capture bundles through xterm to compare renderer options against the recorded stream."
        actions={
          <button type="button" className="codex-terminal-button" onClick={() => void refreshBundles()}>
            {loadingBundles ? "Refreshing..." : "Refresh bundles"}
          </button>
        }
      />

      <div className="split-layout">
        <article className="pane-block">
          <h3 className="block-title">Replay controls</h3>
          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <span className="muted">Recent bundles</span>
              <select
                className="settings-text-input"
                value={bundlePath}
                onChange={(event) => setBundlePath(event.target.value)}
                style={{ width: "100%" }}
              >
                <option value="">Select a recent capture bundle</option>
                {recentBundleOptions.map((bundle) => (
                  <option key={bundle.path} value={bundle.path}>
                    {bundle.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="settings-input-row">
            <input
              className="settings-text-input"
              type="text"
              value={bundlePath}
              onChange={(event) => setBundlePath(event.target.value)}
              placeholder="C:/Users/.../.skala/codex-captures/..."
              spellCheck={false}
            />
            <button type="button" className="codex-terminal-button" onClick={() => void loadBundle()}>
              {loadingBundle ? "Loading..." : "Load bundle"}
            </button>
          </div>

          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <input
                type="checkbox"
                checked={useRecordedTiming}
                onChange={(event) => setUseRecordedTiming(event.target.checked)}
              />
              Replay using recorded timing deltas
            </label>
            <p className="muted settings-help-copy">
              Turn this off to render the full PTY stream instantly after terminal reset.
            </p>
          </div>

          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <input type="checkbox" checked={useWindowsPty} onChange={(event) => setUseWindowsPty(event.target.checked)} />
              Apply xterm <code>windowsPty</code> mode from the capture manifest
            </label>
          </div>

          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <input type="checkbox" checked={convertEol} onChange={(event) => setConvertEol(event.target.checked)} />
              Enable <code>convertEol</code> during replay
            </label>
          </div>

          <div className="settings-input-row">
            <label className="meeting-field" style={{ minWidth: 0 }}>
              <span>Playback speed</span>
              <select
                className="settings-text-input"
                value={playbackSpeed}
                onChange={(event) => setPlaybackSpeed(event.target.value)}
                disabled={!useRecordedTiming}
                style={{ width: "100%" }}
              >
                <option value="0.5">0.5x</option>
                <option value="1">1x</option>
                <option value="4">4x</option>
                <option value="10">10x</option>
                <option value="20">20x</option>
              </select>
            </label>
          </div>

          <div className="meeting-button-row">
            <button
              type="button"
              className="codex-terminal-button"
              onClick={() => setReplayTrigger((current) => current + 1)}
              disabled={!loadedBundle}
            >
              Replay
            </button>
            <button type="button" className="codex-terminal-button" onClick={() => stopReplay()} disabled={!isPlaying}>
              Stop
            </button>
            <button
              type="button"
              className="codex-terminal-button"
              onClick={() => {
                stopReplay("Replay terminal cleared.");
                terminalRef.current?.clear();
                terminalRef.current?.reset();
              }}
            >
              Clear terminal
            </button>
          </div>

          <p className="muted settings-help-copy">{replayStatus}</p>
          {errorMessage && <p className="muted settings-help-copy">{errorMessage}</p>}
        </article>

        <article className="pane-block terminal-pane">
          <h3 className="block-title">Replay terminal</h3>
          <div className="codex-terminal-surface" style={{ height: 420 }}>
            <div ref={hostRef} className="codex-terminal-host" />
          </div>
        </article>
      </div>

      <article className="pane-block">
        <h3 className="block-title">Loaded bundle</h3>
        {loadedBundle ? (
          <dl className="detail-list">
            <div>
              <dt>Session</dt>
              <dd>{loadedBundle.manifest.session_id}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDateTime(loadedBundle.manifest.created_at_ms)}</dd>
            </div>
            <div>
              <dt>Command</dt>
              <dd>{loadedBundle.manifest.command_line}</dd>
            </div>
            <div>
              <dt>Chunks</dt>
              <dd>{loadedBundle.chunks.length}</dd>
            </div>
            <div>
              <dt>PTY mode</dt>
              <dd>
                {loadedBundle.manifest.terminal_host?.windows_pty
                  ? `${loadedBundle.manifest.terminal_host.windows_pty.backend} (${loadedBundle.manifest.terminal_host.windows_pty.build_number ?? "unknown build"})`
                  : "Not recorded"}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{replaySummary ? `${replaySummary.durationMs} ms` : "N/A"}</dd>
            </div>
            <div>
              <dt>PTY chunks</dt>
              <dd>{replaySummary?.ptyChunkCount ?? 0}</dd>
            </div>
            <div>
              <dt>System chunks</dt>
              <dd>{replaySummary?.systemChunkCount ?? 0}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">No capture bundle loaded yet.</p>
        )}
      </article>
    </section>
  );
}
