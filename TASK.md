
`TASKS.md`
```md
# TASKS.md

This file contains concrete implementation tasks for Codex.

Complete one task at a time unless asked otherwise.

---

## Task 1: Create the initial Tauri app shell

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Set up the initial desktop app structure for the product.

### Deliverables
- Tauri app skeleton
- frontend app shell with sidebar and main content area
- placeholder routes/screens for:
  - Home
  - Meetings
  - Runs
  - Vault
  - Codex
  - Settings
- basic persistent app state or placeholder state model
- a short README section describing the shell structure

### Constraints
- do not implement real recording yet
- do not implement real transcription yet
- do not implement real Codex subprocess launching yet
- keep the structure modular and ready for later integration
- avoid overengineering

### Suggested output
A clean initial shell that can become the home for the workflow.

---

## Task 2: Define the core run and artifact model

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Create the foundational data model for runs, artifacts, workspaces, and statuses.

### Deliverables
- types/interfaces/schemas for:
  - Workspace
  - Run
  - Artifact
  - ReviewTask
  - CodexSessionRef
- run status enum/state representation
- storage shape for local persistence
- small documentation note or comments explaining the model

### Constraints
- keep schemas practical
- do not build a database unless needed
- prefer a simple file-backed or app-state-friendly model first

---

## Task 3: Add file import flow for meetings

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Allow the user to create a run from an imported audio/video file.

### Deliverables
- UI entry point for “Import meeting”
- file picker integration
- run creation from selected file
- artifact registration for source media
- run detail view update showing source file metadata

### Constraints
- do not implement transcription yet
- this should stop at creating a valid run with an attached source artifact

---

## Task 4: Add transcription provider abstraction

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Create a provider interface for transcription and wire in a placeholder OpenAI provider.

### Deliverables
- transcription provider interface
- OpenAI provider module stub
- preprocessing/chunking module placeholder
- run state transition hooks for transcription lifecycle
- documentation of how a real provider will plug in later

### Constraints
- it is acceptable to use mocked responses initially
- focus on architecture and boundaries, not full transcription logic

---

## Task 5: Build transcript review UI

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Create the UI for reviewing transcript-related artifacts.

### Deliverables
- run detail area with tabs for:
  - raw transcript
  - cleaned transcript
  - structured note
- right-side review/context panel
- placeholder confidence/warnings area
- bottom logs or status panel if useful

### Constraints
- use mock artifacts if necessary
- focus on layout and future usability

---

## Task 6: Add Obsidian publish preview flow

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Create a review-first publish flow for vault output.

### Deliverables
- vault settings/config UI
- publish preview component
- target path preview
- overwrite warning state
- placeholder publish action

### Constraints
- do not silently write into arbitrary files
- keep the UX explicit and conservative

---

## Task 7: Embed Codex CLI surface

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Prepare the app to host Codex workflows.

### Deliverables
- Codex screen/panel
- subprocess integration scaffold for Codex CLI
- terminal-like UI component or placeholder
- workspace selection for Codex sessions
- session metadata placeholder model

### Constraints
- do not reimplement Codex
- wrap Codex CLI as a subprocess-oriented integration
- it is acceptable to stop at a scaffold if terminal streaming is not fully implemented yet

---

## Task 8: Add meeting recording scaffold

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Prepare the app for in-app recording.

### Deliverables
- recording service abstraction
- UI for recording mode selection:
  - mic
  - system audio
  - mic + system audio
- recording state model
- placeholder native command hooks
- a note in docs on platform-specific implementation expectations

### Constraints
- do not fake cross-platform parity
- it is acceptable to implement only a scaffold first

---

## Task 9: Create an end-to-end mock workflow demo

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Demonstrate the intended product flow even if some services are mocked.

### Deliverables
- start a run
- import a file
- generate mock transcript artifacts
- show transcript review UI
- show note preview
- show publish preview
- navigate into Codex panel

### Constraints
- prioritize proving the product shape over backend completeness

---

## Task 10: Replace mocks with the first real backend

Read `AGENTS.md` and `PLANS.md` first.

### Goal
Implement the first real backend path that creates practical value.

### Preferred order
1. real file import and run persistence
2. real OpenAI transcription integration
3. real publish-to-vault flow
4. real Codex CLI subprocess launching
5. real recording on target platform

### Constraint
Work incrementally and keep each step testable.

---

## Recommended execution order

Suggested order for implementation:
1. Task 1
2. Task 2
3. Task 3
4. Task 5
5. Task 4
6. Task 6
7. Task 7
8. Task 8
9. Task 9
10. Task 10

---

## Example prompt to give Codex

```text
Read AGENTS.md, PLANS.md, and TASKS.md.

Complete Task 1: Create the initial Tauri app shell.

Keep the implementation modular and aligned with the product direction.
Do not implement speculative backend logic yet.
When finished, summarize what you changed and any assumptions.