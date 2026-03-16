# KNOWN_ISSUES

## Issue
Embedded Codex terminal rendering has been hardened around a byte-faithful PTY transport, but the supported target is currently compact mode (`--no-alt-screen`) first.

## Report Window
- First reported: March 13, 2026
- Last implementation pass: March 16, 2026
- Environment: Windows desktop, Tauri app, embedded xterm.js panel

## Current Status
- PTY output is now emitted as raw bytes encoded to base64 with a per-session monotonic sequence number.
- The frontend writes PTY output back into xterm as `Uint8Array` without `convertEol` rewriting.
- Out-of-order chunks are reordered by `seq`, with a `50ms` gap timeout before skipping a missing range.
- Resize/fitting is debounced and deferred while the terminal is focused and the user is actively typing.
- React terminal history is limited to system entries only; PTY output is no longer replayed through React state.

## Supported Mode
- Supported target for this pass: compact mode with `--no-alt-screen` enabled.
- Full-screen / alternate-screen Codex TUI behavior is still considered follow-up hardening work.

## Remaining Caveat
- If Codex relies heavily on full alternate-screen redraw behavior, the embedded xterm surface may still show redraw instability compared with compact mode.
- Debug-build instrumentation now logs chunk sequence, byte counts, queue depth, resize deferrals, and exit codes to help diagnose any remaining issues.

## Acceptance Criteria For Closure
1. No split command text in `/sk` -> `/skills` stress testing while compact mode is enabled.
2. No artificial blank-line inflation over repeated command palette usage in compact mode.
3. No cursor jump on Space/Delete in the active prompt line during compact-mode testing.
4. Stable lifecycle handling with one start message, one exit message, and no stale input routing after exit.
