# Backlog

Known improvements deferred from code reviews and audits.

## Testing

- (no outstanding gaps)

## Code Quality

- **CLI arg parsing refactor** — `src/index.ts` uses a manual index-tracking loop for flag parsing. Low priority: the flag set is small and unlikely to grow.

## Features

- **True mid-step interjection (kill + resume)** — The current `i` key queues a correction for the *next* Claude step. To truly stop a running Claude step and redirect it mid-execution, the approach is: kill the subprocess, then re-invoke with `--resume <session_id>` (captured from the result event) and the user's correction prepended. This preserves conversation context while immediately stopping the bad action. The `session_id` is available in Claude CLI's `result` event. The TUI would show a "restarting with correction…" log line. Blocked on: deciding UX (separate keybinding like `I` vs. a mode toggle), and verifying `--resume` behavior with `--output-format stream-json`.

- **OpenCode server-mode integration** — The current OpenCode runner uses `opencode run --format json` (CLI subprocess). A more robust integration would use OpenCode's HTTP server API (sessions, SSE event stream, messages endpoint). This enables better session management, lower startup overhead, and potentially mid-session context carry-over. Blocked on: OpenCode server API stabilizing.

## Implemented (code review fixes, 2026-06)

- ✅ **`workDir` in `RunOptions`** — `.executant-cancel` is now checked next to the workflow YAML (`dirname(resolve(filePath))`) rather than fixed to `process.cwd()` at module load time; predictable regardless of invocation directory.
- ✅ **`lastStepOutput` on `continueOnError` failures** — `workflow:complete.lastOutput` now always reflects the last *executed* step (including failing `continueOnError` steps), not the last *successful* step.
- ✅ **CI stdout flush before `process.exit(4)`** — `workflow:cancelled` in CI mode now exits only after the write callback confirms the data was flushed to the OS, preventing truncation on piped streams.
- ✅ **`lines[]` ring buffer** — output lines are capped at `LAST_OUTPUT_MAX_LINES` (100) during collection via shift-on-overflow; memory cost is constant regardless of step verbosity.
- ✅ **Shared `startTimeout` helper** — duplicated timeout pattern extracted to `stream.ts`; `command.ts` and `claude.ts` both use `startTimeout(proc, taskName, timeoutSeconds)`.

## Implemented (operator feedback, 2025-06)

- ✅ **`--var KEY=VALUE` CLI flag** — override or supply workflow vars at runtime without editing YAML; multiple flags accepted; CLI overrides YAML.
- ✅ **Auto-create task directories** — `tasks/todo` and `tasks/done` under `.claude/executant.local/` are created automatically on startup.
- ✅ **`lastOutput` on events** — `step:error` and `workflow:complete` carry the last 100 lines of step output, giving CI consumers structured context without slicing raw NDJSON.
- ✅ **File-based cancellation** — writing `.executant-cancel` in the working directory stops execution cleanly between steps; exits 4.
- ✅ **Per-step `timeout_seconds`** — script and prompt steps accept `timeout_seconds: N`; kills the subprocess and throws `TimeoutError` (exit code 3).
- ✅ **Distinct exit codes** — 0 success, 1 runtime failure, 2 validation error, 3 timeout, 4 cancelled.
