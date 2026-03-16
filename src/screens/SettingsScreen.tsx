import { useEffect, useState } from "react";
import { PaneHeader } from "../components/shell/PaneHeader";
import type { Workspace } from "../models/workspace";
import type { TranscriptionSettings } from "../lib/meetingApi";

interface SettingsScreenProps {
  workspace: Workspace;
  selectedCategory: string;
  codexCommandPath: string;
  codexDisableAltScreen: boolean;
  codexCaptureDebugBundle: boolean;
  documentsOpenInNewTab: boolean;
  transcriptionSettings: TranscriptionSettings;
  transcriptionStatusMessage: string | null;
  onCodexCommandPathChange: (value: string) => void;
  onCodexDisableAltScreenChange: (value: boolean) => void;
  onCodexCaptureDebugBundleChange: (value: boolean) => void;
  onDocumentsOpenInNewTabChange: (value: boolean) => void;
  onSaveTranscriptionSettings: (settings: TranscriptionSettings) => Promise<void>;
}

const codexPathSuggestions = [
  "codex",
  "C:/Users/AxelKarlsson/AppData/Roaming/npm/codex.cmd",
  "C:/Users/AxelKarlsson/AppData/Roaming/npm/codex.ps1",
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.306.996.0_x64__2p2nqsd0c76g0/app/Codex.exe",
  "C:/Program Files/WindowsApps/OpenAI.Codex_26.306.996.0_x64__2p2nqsd0c76g0/app/resources/codex.exe"
];

export function SettingsScreen({
  workspace,
  selectedCategory,
  codexCommandPath,
  codexDisableAltScreen,
  codexCaptureDebugBundle,
  documentsOpenInNewTab,
  transcriptionSettings,
  transcriptionStatusMessage,
  onCodexCommandPathChange,
  onCodexDisableAltScreenChange,
  onCodexCaptureDebugBundleChange,
  onDocumentsOpenInNewTabChange,
  onSaveTranscriptionSettings
}: SettingsScreenProps) {
  const [draftCodexPath, setDraftCodexPath] = useState(codexCommandPath);
  const [draftTranscriptionSettings, setDraftTranscriptionSettings] =
    useState<TranscriptionSettings>(transcriptionSettings);
  const [savingTranscription, setSavingTranscription] = useState(false);

  useEffect(() => {
    setDraftCodexPath(codexCommandPath);
  }, [codexCommandPath]);

  useEffect(() => {
    setDraftTranscriptionSettings(transcriptionSettings);
  }, [transcriptionSettings]);

  const categoryCopy: Record<
    string,
    {
      title: string;
      description: string;
      rows: Array<{ label: string; value: string }>;
    }
  > = {
    "settings-general": {
      title: "General",
      description: "Core shell and behavior defaults for the desktop workbench.",
      rows: [
        { label: "Theme", value: "Dark-first with light option" },
        { label: "Layout", value: "Two-part sidebar + workspace panes" },
        { label: "Density", value: "Compact desktop" },
        {
          label: "Documents note click",
          value: documentsOpenInNewTab ? "Open in new tab" : "Open in current tab"
        }
      ]
    },
    "settings-workspace": {
      title: "Workspace",
      description: "Workspace paths and run defaults.",
      rows: [
        { label: "Name", value: workspace.name },
        { label: "Root path", value: workspace.rootPath },
        { label: "Status", value: workspace.status }
      ]
    },
    "settings-vault": {
      title: "Vault",
      description: "Review-first publish targeting for Obsidian.",
      rows: [
        { label: "Vault path", value: workspace.obsidian.vaultPath },
        { label: "Publish folder", value: workspace.obsidian.publishFolder },
        { label: "Safe mode", value: workspace.obsidian.safeMode ? "Enabled" : "Disabled" }
      ]
    },
    "settings-transcription": {
      title: "Transcription",
      description: "Configure OpenAI transcription, cleanup, FFmpeg, and optional speaker diarization.",
      rows: [
        { label: "Primary provider", value: "OpenAI" },
        { label: "Transcription model", value: transcriptionSettings.transcriptionModel },
        { label: "Cleanup model", value: transcriptionSettings.cleanupModel },
        { label: "Diarization", value: transcriptionSettings.diarizationEnabled ? "Enabled" : "Disabled" }
      ]
    },
    "settings-codex": {
      title: "Codex",
      description: "Configure the executable, terminal mode, and debug capture used by the embedded Codex session.",
      rows: [
        { label: "Execution mode", value: "Local subprocess" },
        { label: "Workspace binding", value: workspace.rootPath },
        { label: "Configured command", value: codexCommandPath || "codex" },
        { label: "Terminal mode", value: codexDisableAltScreen ? "Compact (--no-alt-screen)" : "Full screen" },
        { label: "Debug capture", value: codexCaptureDebugBundle ? "Enabled" : "Disabled" }
      ]
    }
  };

  const content = categoryCopy[selectedCategory] ?? categoryCopy["settings-general"];

  return (
    <section className="workspace-screen">
      <PaneHeader eyebrow="Settings" title={content.title} subtitle={content.description} />

      <article className="pane-block">
        <dl className="detail-list">
          {content.rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </article>

      {selectedCategory === "settings-transcription" && (
        <article className="pane-block">
          <h3 className="block-title">OpenAI transcription settings</h3>
          <div className="meeting-form-grid">
            <label className="meeting-field">
              <span>OpenAI API key</span>
              <input
                className="settings-text-input"
                type="password"
                value={draftTranscriptionSettings.openAiApiKey ?? ""}
                onChange={(event) =>
                  setDraftTranscriptionSettings((current) => ({
                    ...current,
                    openAiApiKey: event.target.value
                  }))
                }
                placeholder="sk-..."
                spellCheck={false}
              />
            </label>
            <label className="meeting-field">
              <span>Cleanup model</span>
              <input
                className="settings-text-input"
                type="text"
                value={draftTranscriptionSettings.cleanupModel}
                onChange={(event) =>
                  setDraftTranscriptionSettings((current) => ({
                    ...current,
                    cleanupModel: event.target.value
                  }))
                }
                spellCheck={false}
              />
            </label>
            <label className="meeting-field">
              <span>FFmpeg path</span>
              <input
                className="settings-text-input"
                type="text"
                value={draftTranscriptionSettings.ffmpegPath}
                onChange={(event) =>
                  setDraftTranscriptionSettings((current) => ({
                    ...current,
                    ffmpegPath: event.target.value
                  }))
                }
                placeholder="ffmpeg"
                spellCheck={false}
              />
            </label>
          </div>

          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <input
                type="checkbox"
                checked={draftTranscriptionSettings.diarizationEnabled}
                onChange={(event) =>
                  setDraftTranscriptionSettings((current) => ({
                    ...current,
                    diarizationEnabled: event.target.checked
                  }))
                }
              />
              Enable speaker diarization when OpenAI supports it for the uploaded audio
            </label>
            <p className="muted settings-help-copy">
              When enabled, the raw transcript keeps speaker labels and the cleanup pass preserves them. FFmpeg is also required for live recording and for oversized uploads that need preprocessing.
            </p>
          </div>

          <div className="meeting-button-row">
            <button
              type="button"
              className="codex-terminal-button"
              onClick={async () => {
                setSavingTranscription(true);
                try {
                  await onSaveTranscriptionSettings(draftTranscriptionSettings);
                } finally {
                  setSavingTranscription(false);
                }
              }}
            >
              {savingTranscription ? "Saving..." : "Save transcription settings"}
            </button>
          </div>

          <p className="muted settings-help-copy">
            {transcriptionStatusMessage ?? "Settings are stored locally. OPENAI_API_KEY is still used as a fallback."}
          </p>
        </article>
      )}

      {selectedCategory === "settings-codex" && (
        <article className="pane-block">
          <h3 className="block-title">Codex executable path</h3>
          <p className="muted settings-help-copy">
            Set the command or full executable path used when starting a Codex session. On Windows,
            <code>codex.cmd</code> and <code>codex.ps1</code> paths are handled automatically.
          </p>

          <div className="settings-input-row">
            <input
              className="settings-text-input"
              type="text"
              value={draftCodexPath}
              onChange={(event) => setDraftCodexPath(event.target.value)}
              placeholder="codex"
              spellCheck={false}
            />
            <button
              type="button"
              className="codex-terminal-button"
              onClick={() => onCodexCommandPathChange(draftCodexPath.trim())}
            >
              Apply
            </button>
          </div>

          <div className="settings-quick-paths">
            {codexPathSuggestions.map((path) => (
              <button
                key={path}
                type="button"
                className="settings-path-button"
                onClick={() => {
                  setDraftCodexPath(path);
                  onCodexCommandPathChange(path);
                }}
              >
                {path}
              </button>
            ))}
          </div>

          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <input
                type="checkbox"
                checked={codexDisableAltScreen}
                onChange={(event) => onCodexDisableAltScreenChange(event.target.checked)}
              />
              Use compact mode (<code>--no-alt-screen</code>)
            </label>
            <p className="muted settings-help-copy">
              Compact mode can reduce full-screen redraws in the dock. Turn it off for native full-screen Codex UI.
            </p>
          </div>

          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <input
                type="checkbox"
                checked={codexCaptureDebugBundle}
                onChange={(event) => onCodexCaptureDebugBundleChange(event.target.checked)}
              />
              Capture a debug bundle for the next Codex session
            </label>
            <p className="muted settings-help-copy">
              This writes a session bundle under <code>.skala/codex-captures</code> with raw PTY output,
              frontend render events, resize timing, and terminal input. Use it only while reproducing the bug.
            </p>
          </div>
        </article>
      )}

      {selectedCategory === "settings-general" && (
        <article className="pane-block">
          <h3 className="block-title">Documents behavior</h3>
          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <input
                type="checkbox"
                checked={documentsOpenInNewTab}
                onChange={(event) => onDocumentsOpenInNewTabChange(event.target.checked)}
              />
              Open notes in a new tab when clicked in the sidebar
            </label>
            <p className="muted settings-help-copy">
              Turn this off to reuse the current tab instead of opening a new one.
            </p>
          </div>
        </article>
      )}

      <article className="pane-block">
        <h3 className="block-title">Review-first note</h3>
        <p className="muted">
          Settings remain conservative in v1: explicit review checkpoints, no silent vault overwrites, and
          backend integrations added incrementally.
        </p>
      </article>
    </section>
  );
}

