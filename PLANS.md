# PLANS.md

## Overview

This project is a Tauri desktop app for personal work assistance.

The product combines:
- meeting capture and file import
- transcription
- transcript cleanup and structured note generation
- safe publishing into an Obsidian vault
- embedded Codex CLI for terminal-based work inside the app
- thought-partner workflows for synthesis and planning

The goal is to build something that becomes useful in daily work quickly, without overbuilding.

---

## Product definition

### What the product is

A desktop workbench for turning meetings, recordings, notes, and related material into useful outputs.

It should help the user:
- capture or import meetings
- transcribe them
- create useful structured notes
- review and publish into Obsidian
- use Codex in the same app for follow-up work
- synthesize material into summaries, plans, or deck/storyline briefs

### What the product is not

It is not:
- a fully autonomous assistant
- a background process that edits the vault on its own
- a generic all-purpose chat wrapper
- a full PowerPoint automation platform in v1
- a clone of CodexMonitor

The product may borrow UX ideas from CodexMonitor, but should remain focused on the user’s meeting and note workflows.

---

## Product principles

1. Workflow-first, not chat-first
2. Review-first, not auto-write
3. Desktop-first, not browser-first
4. Modular services, not one giant prompt
5. Useful quickly, then deepen
6. Honest scoping for platform-specific capabilities

---

## Core user jobs

### Job 1: Capture a meeting
The user wants to record a meeting or import an existing file.

### Job 2: Turn it into something useful
The user wants a transcript, a cleaned version, and structured notes.

### Job 3: Save it into their knowledge system
The user wants outputs staged and then published into Obsidian safely.

### Job 4: Continue working immediately
The user wants Codex inside the app so they can keep working in the same environment.

### Job 5: Think through follow-up work
The user wants the app to help with summaries, stakeholder updates, deck storylines, and next steps.

---

## Recommended v1 scope

### Must-have

- Tauri shell
- workspace and settings
- file import
- meeting recording
- microphone capture
- system audio capture where feasible
- transcription provider abstraction
- OpenAI transcription provider
- cleaned transcript generation
- structured meeting note generation
- Obsidian preview/publish flow
- run history and artifact storage
- embedded Codex CLI session
- terminal/process output panel

### Nice-to-have

- diarization mode
- note-link suggestions
- deck brief generation
- configurable templates
- retry/resume support
- confidence indicators
- better run search/filtering

### Too ambitious for v1

- arbitrary PPTX editing
- true multi-agent orchestration
- full CodexMonitor-style workspace fleet management
- remote backends
- full cross-platform-perfect system audio capture from day one
- automatic updates to canonical project notes

---

## High-level architecture

```text
Tauri App
├── UI shell
├── Native command / process bridge
├── Workflow engine
├── Service adapters
├── Codex runtime integration
└── Artifact + config storage