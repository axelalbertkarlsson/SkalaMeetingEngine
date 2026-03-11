# AGENTS.md

## Project intent

This repository is for a personal desktop work assistant built as a Tauri app.

The app should help the user:
- record or import meetings
- transcribe recordings
- turn transcripts into useful structured notes
- review outputs before publishing to an Obsidian vault
- use Codex inside the app with terminal access
- use the app as a thought partner for synthesis and planning tasks

This is not a generic chatbot product. It is a workflow-oriented desktop tool.

---

## Product principles

Prefer simple, robust building blocks over complex architecture.

Optimize for something that becomes useful in daily work quickly.

Do not over-automate in v1.

Favor explicit review points over silent automation.

Keep the implementation modular so that recording, transcription, note generation, publishing, and Codex integration can evolve independently.

---

## Core v1 scope

Version 1 should support:

1. Tauri desktop shell
2. Workspace setup
3. Obsidian vault configuration
4. Meeting file import
5. In-app meeting recording
   - microphone support
   - system audio support where feasible
   - microphone + system audio mixed where feasible
6. OpenAI API transcription as the first transcription backend
7. Cleaned transcript generation
8. Structured meeting note generation
9. Review and publish flow for Obsidian
10. Embedded Codex CLI inside the app
11. Terminal/process output view
12. Run history and artifact storage

---

## Explicit non-goals for v1

Do not implement these unless explicitly asked:

- arbitrary PowerPoint editing
- broad PPTX automation
- multi-agent orchestration
- remote daemon mode
- autonomous editing of arbitrary vault files
- silent overwrite behavior
- real-time meeting copilot features
- full GitHub/devops orchestration features similar to CodexMonitor
- background indexing of the full vault without a clear product need

Thought-partner support for decks is allowed.
PPTX automation should be deferred.

---

## Architecture rules

Use a layered structure:

1. Tauri UI shell
2. Native command layer / process bridge
3. Local workflow engine
4. Service adapters
5. Storage/artifact layer

Keep business logic outside the UI where possible.

The UI should orchestrate workflows and display state, but core logic should live in reusable services/modules.

---

## Recording rules

Recording is a first-class feature.

The app should support:
- importing existing audio/video files
- recording from mic
- recording system/computer audio where possible
- recording mixed inputs where possible

System audio capture is platform-specific.
Do not pretend it is trivial or fully portable.

Implement recording through a platform-aware abstraction.

If needed, support one operating system well first instead of shipping a weak cross-platform implementation.

Always keep file import as a fallback path.

---

## Transcription rules

Use OpenAI transcription API as the first backend.

Design transcription behind an interface so additional backends can be added later.

Planned interface shape:

- create transcription job
- preprocess input if needed
- chunk/compress long files
- submit to provider
- stitch results
- save transcript artifacts

Keep room for later providers such as:
- easytranscriber
- local whisper-style backends

Do not hardcode the whole app around one transcription provider.

---

## Codex rules

Codex inside the app should use local Codex CLI, not a custom coding-agent implementation.

Prefer:
- spawning Codex CLI as a subprocess
- connecting stdin/stdout/stderr to an in-app terminal/session surface
- running Codex in a selected workspace
- storing session metadata in the app

Do not build a separate LLM coding runtime if Codex CLI already covers the need.

Assume Codex authentication is handled through the user’s existing Codex/ChatGPT-compatible login flow where supported.

Keep Codex integration separate from OpenAI API service logic.

---

## Obsidian rules

Obsidian is the publishing target, not the raw working store.

The app must support:
- vault configuration
- preview before publish
- safe output paths
- explicit publish action

Do not:
- overwrite existing notes silently
- mutate unrelated vault files automatically
- write directly into canonical project notes without review

Preferred v1 behavior:
- store raw artifacts outside the vault
- generate preview files first
- publish only after user approval

---

## Output rules for meeting processing

A meeting-processing flow should eventually produce:

- raw recording artifact
- raw transcript artifact
- cleaned transcript artifact
- structured extraction artifact
- Obsidian-ready meeting note preview
- publish log if published

Structured extraction should aim to include:
- summary
- decisions
- action items
- owners
- deadlines
- blockers
- risks
- open questions
- suggested links
- confidence markers or evidence references where possible

Avoid overclaiming certainty.

---

## UX rules

This app should feel like a focused desktop workbench.

Prefer a run-centric UX over a generic chat UX.

The main UI should revolve around:
- workspaces
- runs
- artifacts
- review checkpoints
- publishing
- Codex sessions

The app may include chat/thought-partner experiences, but chat should not be the only interaction model.

Prefer:
- guided workflows
- explicit progress stages
- clear review panels
- structured previews
- logs and terminal visibility

---

## Code quality rules

Keep modules small and composable.

Add clear types/interfaces for:
- runs
- artifacts
- provider configuration
- recording jobs
- transcription jobs
- publish actions
- Codex sessions

Avoid premature abstraction, but do not bury critical logic inside UI components.

Document assumptions where platform-specific behavior exists.

---

## Safety and review rules

Treat meeting extraction as potentially wrong.

Prefer conservative output over hallucinated confidence.

Owners, deadlines, and decisions should only be asserted strongly when supported by transcript evidence or explicit user edits.

Publishing to Obsidian must remain review-first in v1.

---

## Delivery style for implementation tasks

When implementing tasks in this repo:

- make the smallest coherent change that advances the product
- keep files organized and readable
- include brief documentation when adding architecture or modules
- note important tradeoffs in comments or README where useful
- do not add large speculative systems unless requested

If a request is too broad, break it into a few grounded implementation steps and complete the first useful one.