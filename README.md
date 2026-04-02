# Skala Meeting Engine

Skala Meeting Engine is a Tauri + React desktop workbench for meeting capture, transcription review, local note editing, and embedded Codex workflows.

This README reflects the current code in this repository as of March 20, 2026. It focuses on what is implemented now, not just the original product intent.

## Current status

The app already includes a working desktop shell, persisted meeting runs, OpenAI-based transcription, transcript artifact review, a local markdown documents workspace, and embedded Codex subprocess support.

Some areas are still scaffold-level:

- Obsidian publishing is represented in the UI, but there is no publish execution backend yet.
- The Vault and Runs sections are read-only views.
- The dedicated Codex screen is a capture replay harness; the live Codex subprocess terminal is exposed through the bottom panel in the Codex section.

## Implemented features

### Workspace shell

- Pane-based desktop layout with:
  - permanent icon rail
  - collapsible sidebar
  - tabbed workspace center pane
  - optional inspector pane
  - optional bottom utility panel
- Sections:
  - Home
  - Meetings
  - Documents
  - Vault
  - Runs
  - Codex
  - Settings

### Meetings

- Import audio or video files into a persisted meeting run.
- Live recording on Windows:
  - microphone capture via FFmpeg / DirectShow
  - system audio capture via native Windows WASAPI loopback
  - mixed capture by recording microphone and system audio separately, then mixing them on stop
- Persisted meeting run storage under the workspace root.
- Artifact review UI for:
  - cleaned transcript
  - raw transcript
  - provider response
  - artifact file list
- Run operations:
  - refresh
  - retranscribe from saved source media
  - delete transcript artifacts while keeping the source recording
  - delete the full run
  - open artifact location
  - copy artifact path

### Transcription pipeline

- OpenAI is the active transcription backend.
- Pipeline stages in the Tauri backend:
  - queue transcription
  - optionally preprocess large files with FFmpeg
  - upload audio to OpenAI
  - stitch chunked transcripts
  - store raw provider response
  - store raw transcript
  - run cleanup model pass
  - store cleaned transcript as Markdown
- Configurable transcription settings:
  - OpenAI API key
  - cleanup model
  - FFmpeg path
  - speaker diarization toggle
- Current default models in code:
  - transcription: `gpt-4o-transcribe`
  - cleanup: `gpt-5-mini`

### Documents

- Local markdown note workspace built with Milkdown.
- Split editor + preview layout.
- Per-note persistence through Tauri document commands.
- Configurable base path for notes.
- Local storage fallback / caching in the frontend.
- Sidebar-driven document tree and note opening behavior managed from the main app shell.

### Codex integration

- Embedded Codex subprocess support through a PTY-backed terminal.
- Terminal capabilities:
  - start
  - stop
  - send input
  - resize
  - clear session output
- Optional debug capture bundle recording for terminal traffic.
- Capture replay harness in the Codex screen for comparing PTY rendering behavior against recorded bundles.
- Local command path configuration, including Windows-specific command suggestions.

### Spellcheck

- Generated bundled dictionaries for English and Swedish.
- Personal dictionary persistence through Tauri commands.
- Frontend spellcheck worker/client support in the editor stack.

## What is not implemented yet

- Obsidian publish execution
- structured extraction artifacts for meetings
- review-to-publish workflow automation
- non-Windows live recording backend
- direct device selection UI for microphone/system audio capture
- production-grade multi-workspace persistence beyond the current local state model

## Repository layout

### Frontend

- `src/App.tsx`: app composition, shell state, section routing, Codex session orchestration, meeting refresh logic
- `src/screens/MeetingsScreen.tsx`: meeting capture/import, run review, artifact preview
- `src/screens/DocumentsScreen.tsx`: markdown editing + preview
- `src/screens/CodexScreen.tsx`: capture replay harness
- `src/screens/SettingsScreen.tsx`: Codex, documents, and transcription settings
- `src/components/shell/`: pane shell, sidebars, terminal panel, editor wrappers
- `src/services/`: document persistence and spellcheck persistence clients

### Tauri backend

- `src-tauri/src/commands/meetings.rs`: meeting commands exposed to the frontend
- `src-tauri/src/meetings/recorder.rs`: Windows recording backends
- `src-tauri/src/meetings/transcription.rs`: OpenAI transcription pipeline
- `src-tauri/src/commands/codex.rs`: Codex PTY subprocess management and capture bundle support
- `src-tauri/src/commands/documents.rs`: note file read/write/copy/delete
- `src-tauri/src/commands/spellcheck.rs`: personal dictionary persistence

## Data written by the app

### Workspace-scoped data

- `.skala-meeting-engine/runs/...`
  - meeting run manifests
  - imported media
  - recorded audio
  - transcription artifacts
- `.skala/codex-captures/...`
  - Codex terminal debug capture bundles

### App-data-scoped data

- documents notes directory resolved through the Tauri app data folder when no custom base path is configured
- transcription settings JSON in the app data settings directory
- personal spellcheck dictionary in the app data settings directory

## Prerequisites

- Node.js
- Rust toolchain
- Tauri prerequisites for your platform
- Windows if you want to use live recording
- FFmpeg if you want:
  - microphone recording
  - mixed recording final mixing
  - preprocessing for large or overlong transcription inputs
- OpenAI API key for transcription
- Codex CLI installed locally if you want to use the embedded Codex terminal

## Development

Install dependencies:

```bash
npm install
```

Run the frontend:

```bash
npm run dev
```

Run the Tauri desktop app:

```bash
npm run tauri -- dev
```

Build the frontend:

```bash
npm run build
```

Run the Codex terminal transport test script:

```bash
npm run test:codex-terminal
```

## Notes for contributors

- Live recording is intentionally Windows-first in the current codebase.
- System audio capture no longer depends on Stereo Mix; it uses WASAPI loopback.
- The README, like the app, should stay grounded in implemented behavior rather than planned behavior.
