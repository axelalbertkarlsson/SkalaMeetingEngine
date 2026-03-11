# Skala Meeting Engine

Skala Meeting Engine is a Tauri + React desktop workbench for meeting capture, transcription workflows, review, and safe publishing into Obsidian.

## Current UI shell

The app shell has been refactored from a dashboard layout into a pane-based desktop workspace:

- Permanent icon rail (left): always visible, icon-only, non-collapsible section switcher.
- Collapsible sidebar (left): text/list/tree-oriented context that changes by active rail section.
- Main workspace (center): compact tab bar + active pane content, ready for future tab groups/split views.
- Inspector pane (right): optional context/details panel for metadata, review signals, and extraction state.
- Bottom panel: optional utility panel for logs, status, terminal/Codex output.

## Shell evolution intent

- The icon rail remains the stable workspace anchor and quick command strip.
- The collapsible sidebar is the section-specific navigation/context surface.
- Workspace tabs are the primary content surface and will evolve into multi-pane tab groups.
- Inspector and bottom panels are intentionally optional and independently toggleable to support focused work.

## Included screens

- Home
- Meetings
- Runs
- Vault
- Codex
- Settings

All screens now render inside the same pane-based shell architecture with compact, workflow-oriented placeholders.

## Key frontend files

- App composition/state: `src/App.tsx`
- Shell container: `src/components/AppShell.tsx`
- Shell modules: `src/components/shell/*.tsx`
- Screen content: `src/screens/*.tsx`
- Theme/design tokens and shell styling: `src/styles.css`

## Notes

- This step is UI architecture only.
- Recording, transcription, Codex subprocess runtime, and publish execution remain scaffold-level and are not expanded here.

