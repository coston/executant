# Backlog

Known improvements deferred from code reviews and audits.

## Testing

- (no outstanding gaps)

## Code Quality

- **CLI arg parsing refactor** — `src/index.ts` uses a manual index-tracking loop for flag parsing. Low priority: the flag set is small and unlikely to grow.

## Features

- **True mid-step interjection (kill + resume)** — The current `i` key queues a correction for the *next* Claude step. To truly stop a running Claude step and redirect it mid-execution, the approach is: kill the subprocess, then re-invoke with `--resume <session_id>` (captured from the result event) and the user's correction prepended. This preserves conversation context while immediately stopping the bad action. The `session_id` is available in Claude CLI's `result` event. The TUI would show a "restarting with correction…" log line. Blocked on: deciding UX (separate keybinding like `I` vs. a mode toggle), and verifying `--resume` behavior with `--output-format stream-json`.
