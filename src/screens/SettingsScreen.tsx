import { useEffect, useMemo, useState } from "react";
import { PaneHeader } from "../components/shell/PaneHeader";
import {
  formatReasoningEffortLabel,
  getCodexModelDisplayName,
  getCodexModelSelectOptions,
  getCodexReasoningSelectOptions,
  getResolvedCodexModelOption
} from "../lib/codexModelOptions";
import type { CodexModelOption, CodexReasoningEffort } from "../models/codex";
import type { Workspace } from "../models/workspace";
import type { TranscriptionSettings } from "../lib/meetingApi";

type DocumentsEditorFont = "ibm-plex-sans" | "switzer";

interface SettingsScreenProps {
  workspace: Workspace;
  selectedCategory: string;
  codexCommandPath: string;
  codexCaptureDebugBundle: boolean;
  codexSelectedModel: string | null;
  codexReasoningEffort: CodexReasoningEffort | null;
  codexEffectiveModelId: string | null;
  codexEffectiveReasoningEffort: CodexReasoningEffort | null;
  codexAvailableModels: CodexModelOption[];
  codexModelsLoading: boolean;
  documentsOpenInNewTab: boolean;
  documentsBasePath: string;
  documentsEditorFont: DocumentsEditorFont;
  transcriptionSettings: TranscriptionSettings;
  transcriptionStatusMessage: string | null;
  onCodexCommandPathChange: (value: string) => void;
  onCodexCaptureDebugBundleChange: (value: boolean) => void;
  onCodexSelectedModelChange: (value: string | null) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort | null) => void;
  onDocumentsOpenInNewTabChange: (value: boolean) => void;
  onDocumentsBasePathChange: (value: string) => void;
  onDocumentsEditorFontChange: (value: DocumentsEditorFont) => void;
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
  codexCaptureDebugBundle,
  codexSelectedModel,
  codexReasoningEffort,
  codexEffectiveModelId,
  codexEffectiveReasoningEffort,
  codexAvailableModels,
  codexModelsLoading,
  documentsOpenInNewTab,
  documentsBasePath,
  documentsEditorFont,
  transcriptionSettings,
  transcriptionStatusMessage,
  onCodexCommandPathChange,
  onCodexCaptureDebugBundleChange,
  onCodexSelectedModelChange,
  onCodexReasoningEffortChange,
  onDocumentsOpenInNewTabChange,
  onDocumentsBasePathChange,
  onDocumentsEditorFontChange,
  onSaveTranscriptionSettings
}: SettingsScreenProps) {
  const [draftCodexPath, setDraftCodexPath] = useState(codexCommandPath);
  const [draftDocumentsBasePath, setDraftDocumentsBasePath] = useState(documentsBasePath);
  const [draftTranscriptionSettings, setDraftTranscriptionSettings] =
    useState<TranscriptionSettings>(transcriptionSettings);
  const [savingTranscription, setSavingTranscription] = useState(false);
  const resolvedCodexModelOption = useMemo(
    () => getResolvedCodexModelOption(codexAvailableModels, codexSelectedModel, codexEffectiveModelId),
    [codexAvailableModels, codexEffectiveModelId, codexSelectedModel]
  );
  const codexModelOptions = useMemo(
    () => getCodexModelSelectOptions(codexAvailableModels, codexSelectedModel),
    [codexAvailableModels, codexSelectedModel]
  );
  const codexReasoningOptions = useMemo(
    () => getCodexReasoningSelectOptions(resolvedCodexModelOption, codexReasoningEffort),
    [codexReasoningEffort, resolvedCodexModelOption]
  );
  const selectedCodexReasoningOption = useMemo(
    () =>
      codexReasoningOptions.find((option) => option.reasoningEffort === codexReasoningEffort) ?? null,
    [codexReasoningEffort, codexReasoningOptions]
  );
  const codexReasoningDisabled = !resolvedCodexModelOption && codexReasoningOptions.length === 0;
  const codexSelectedModelLabel = codexSelectedModel
    ? getCodexModelDisplayName(codexAvailableModels, codexSelectedModel) ?? codexSelectedModel
    : null;
  const codexEffectiveModelLabel = getCodexModelDisplayName(codexAvailableModels, codexEffectiveModelId);

  useEffect(() => {
    setDraftCodexPath(codexCommandPath);
  }, [codexCommandPath]);

  useEffect(() => {
    setDraftDocumentsBasePath(documentsBasePath);
  }, [documentsBasePath]);

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
        },
        {
          label: "Documents base path",
          value: documentsBasePath.trim() || "Default (AppData)"
        },
        {
          label: "Documents editor font",
          value: documentsEditorFont === "switzer" ? "Switzer" : "IBM Plex Sans"
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
      description: "Configure the executable used by the shared Codex dock and full-page app-server session.",
      rows: [
        { label: "Execution mode", value: "Local Codex CLI app-server" },
        { label: "Workspace binding", value: workspace.rootPath },
        { label: "Configured command", value: codexCommandPath || "codex" },
        {
          label: "Selected model",
          value: codexSelectedModelLabel
            ?? (codexEffectiveModelLabel
              ? `Default: ${codexEffectiveModelLabel}`
              : "Default")
        },
        {
          label: "Reasoning strength",
          value: codexReasoningEffort
            ? formatReasoningEffortLabel(codexReasoningEffort)
            : codexEffectiveReasoningEffort
              ? `Default: ${formatReasoningEffortLabel(codexEffectiveReasoningEffort)}`
              : "Default"
        },
        { label: "Transport", value: "JSON-RPC over stdio (JSONL)" },
        { label: "Diagnostics", value: codexCaptureDebugBundle ? "Reserved flag enabled" : "Reserved flag disabled" }
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

          <p className="muted settings-help-copy">
            The shared Codex dock and page now talk to <code>codex app-server</code> over stdio.
            The dock stages file paths as structured context, while the page reuses the same live thread.
          </p>

          <div className="meeting-form-grid">
            <label className="meeting-field">
              <span>Model default</span>
              <select
                className="settings-text-input"
                value={codexSelectedModel ?? ""}
                onChange={(event) => onCodexSelectedModelChange(event.target.value || null)}
              >
                <option value="">Default</option>
                {codexModelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.displayName}</option>
                ))}
              </select>
            </label>
            <label className="meeting-field">
              <span>Reasoning strength</span>
              <select
                className="settings-text-input"
                title={selectedCodexReasoningOption?.description ?? "Choose the reasoning strength"}
                value={codexReasoningEffort ?? ""}
                disabled={codexReasoningDisabled}
                onChange={(event) =>
                  onCodexReasoningEffortChange(
                    (event.target.value || null) as CodexReasoningEffort | null
                  )
                }
              >
                <option value="">Default</option>
                {codexReasoningOptions.map((option) => (
                  <option
                    key={option.reasoningEffort}
                    value={option.reasoningEffort}
                    title={option.description ?? undefined}
                  >
                    {formatReasoningEffortLabel(option.reasoningEffort)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="muted settings-help-copy">
            {codexModelsLoading
              ? "Loading the Codex model catalog and effective config from app-server..."
              : resolvedCodexModelOption
                ? codexSelectedModel
                  ? `Reasoning options are constrained to ${resolvedCodexModelOption.displayName}. These defaults are shared by the dock and full-page Codex session.`
                  : `Default model currently resolves to ${resolvedCodexModelOption.displayName}. These defaults are shared by the dock and full-page Codex session.`
                : "Codex has not reported the effective model yet, so reasoning stays constrained to Default. Default model selection still follows your Codex config.toml behavior."}
          </p>

          <div className="settings-toggle-row">
            <label className="settings-toggle-label">
              <input
                type="checkbox"
                checked={codexCaptureDebugBundle}
                onChange={(event) => onCodexCaptureDebugBundleChange(event.target.checked)}
              />
              Keep transport diagnostics flag enabled
            </label>
            <p className="muted settings-help-copy">
              The old PTY capture bundle is no longer used in app-server mode. This toggle is kept only as a
              placeholder for future structured transport diagnostics.
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

          <div className="settings-toggle-row">
            <label className="settings-toggle-label" htmlFor="documents-base-path">
              Documents base path
            </label>
            <p className="muted settings-help-copy">
              Folder where note <code>.md</code> files are stored. Leave empty to use the default app data path.
            </p>
            <div className="settings-input-row">
              <input
                id="documents-base-path"
                className="settings-text-input"
                type="text"
                value={draftDocumentsBasePath}
                onChange={(event) => setDraftDocumentsBasePath(event.target.value)}
                placeholder="C:/Users/AxelKarlsson/Documents/SkalaNotes"
                spellCheck={false}
              />
              <button
                type="button"
                className="codex-terminal-button"
                onClick={() => onDocumentsBasePathChange(draftDocumentsBasePath.trim())}
              >
                Apply
              </button>
              <button
                type="button"
                className="settings-path-button"
                onClick={() => {
                  setDraftDocumentsBasePath("");
                  onDocumentsBasePathChange("");
                }}
              >
                Use default
              </button>
            </div>
          </div>

          <div className="settings-toggle-row">
            <label className="settings-toggle-label" htmlFor="documents-editor-font">
              Documents editor font
            </label>
            <p className="muted settings-help-copy">
              Font used in the Milkdown editor pane for writing markdown notes.
            </p>
            <div className="settings-input-row">
              <select
                id="documents-editor-font"
                className="settings-text-input"
                value={documentsEditorFont}
                onChange={(event) => onDocumentsEditorFontChange(event.target.value as DocumentsEditorFont)}
              >
                <option value="ibm-plex-sans">IBM Plex Sans</option>
                <option value="switzer">Switzer</option>
              </select>
            </div>
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

