# Backlog

Known improvements deferred from code reviews and audits.

## Testing

- (no outstanding gaps)

## Code Quality

- **CLI arg parsing refactor** — `src/index.ts` uses a manual index-tracking loop for flag parsing. Low priority: the flag set is small and unlikely to grow.

## Features

- **True mid-step interjection (kill + resume)** — The current `i` key queues a correction for the _next_ Claude step. To truly stop a running Claude step and redirect it mid-execution, the approach is: kill the subprocess, then re-invoke with `--resume <session_id>` (captured from the result event) and the user's correction prepended. This preserves conversation context while immediately stopping the bad action. The `session_id` is available in Claude CLI's `result` event. The TUI would show a "restarting with correction…" log line. Blocked on: deciding UX (separate keybinding like `I` vs. a mode toggle), and verifying `--resume` behavior with `--output-format stream-json`.

- **OpenCode server-mode integration** — The current OpenCode runner uses `opencode run --format json` (CLI subprocess). A more robust integration would use OpenCode's HTTP server API (sessions, SSE event stream, messages endpoint). This enables better session management, lower startup overhead, and potentially mid-session context carry-over. Blocked on: OpenCode server API stabilizing.

- **Per-attempt heal/judge child spans** — Telemetry v1 models self-healing and judge activity as span _events_ on the step span. Modelling each heal/judge attempt as its own child span needs start-boundary events from the runner (`step:attempt` / `judge:start` — only completion is emitted today) and `TRACEPARENT` propagation into the judge subprocess so its work nests under the attempt span.

- **Complete cost accounting** — Judge-evaluation cost is dropped inside `runClaudeStructured` (`src/tasks/claude.ts` consumes the event stream for `output:structured`/`output:text` only), and the OpenCode runner does not parse cost from its JSON output at all. Surfacing both would make the `executant.cost.usd` metric and per-step cost attributes complete.

- **Richer nested-workflow progress UI** — `workflow:` steps (`src/resolve-workflow.ts`, `runNestedWorkflow` in `src/runner.ts`) currently surface their child steps as flat `output:text` log lines under the parent step, not a structured nested view. A `StepNestedEvent` (mirroring `step:inner`) plus a dedicated row component (mirroring `IterationRow.tsx`) would let the TUI render real nested progress. Deferred for v1: the flat-log approach reuses 100% existing plumbing and needed zero UI changes; revisit if users want to see per-child-step status at a glance rather than in the log pane.

- **`--from-step`/`--step`/`--to-step` targeting into a nested workflow step** — currently rejected outright with a clear error (`runNestedWorkflow` in `src/runner.ts`) rather than resuming into the child's own step list. Supporting it would mean extending the dot-notation `FromStepTarget` path semantics (currently step → forEach-iteration → child-step) to also cross a `workflow:` boundary.

- **`workflow:` steps inside `forEach`/`repeat`** — rejected at load time (`src/load-workflow.ts`). A nested workflow is resolved once, eagerly, before any iteration runs; threading a per-iteration `{{item}}` into it would mean re-resolving (and re-fetching, for a remote reference) once per item, which breaks the "fail fast before any step runs" guarantee eager resolution is meant to provide.

- **Vars-aware caching in `resolveWorkflow`** — two `workflow:` steps referencing the same file are currently fetched and parsed independently. A cache would need to key on the resolved path/URL *and* the step's `vars:` override (serialized), since two steps referencing the same file with different overrides must not share a resolved `Workflow` — added complexity that isn't justified without evidence repeated-reference workflows are common.

## Implemented (workflow authoring, 2026-08)

- ✅ **`output:` on prompt steps** — previously only script/command steps captured stdout to the named file; on a prompt step `output:` parsed fine but was silently a no-op. Now a prompt step's `output:` checks the named file exists after the step completes (a prompt step's real artifact is whatever it wrote via tool calls, not its narration text) and fails the step if it doesn't — no self-healing/judge retry on that failure, deliberately, for the same reason self-healing stays off deterministic script steps whose failure should hard-stop the run. Setting `output:` on a `log`/`workflow` step (which have nothing to produce) is now a load-time error instead of a silent no-op.

## Implemented (observability, 2026-07)

- ✅ **Structured `step:healing` / `step:judge` events** — the self-healing loop and LLM-as-judge now emit typed events (phase/attempt/exit code; verdict/attempt/feedback) alongside the existing free-text logs, giving CI NDJSON consumers and telemetry machine-readable quality-control progress.
- ✅ **Indexed `output:cost`** — cost events now carry the 0-based step index (`-1` sentinel patched by `runWorkflow`, like `output:tool`), enabling per-step cost attribution.
- ✅ **OpenTelemetry telemetry module (`src/telemetry.ts`)** — opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`; one trace per run (root → step → iteration spans with tool/healing/judge span events and cost attributes) plus five metrics, exported via OTLP/HTTP and flushed on every exit path including SIGINT; all `@opentelemetry/*` imports are dynamic, so the SDK is never loaded when the env var is unset.
- ✅ **`TRACEPARENT` propagation** — all three spawn sites (claude, opencode, bash) spread `traceparentEnv()` from the `src/lib/trace-context.ts` registry into the child env, so subprocesses join the current step's trace; a no-op when telemetry is off.
- ✅ **CI mode skips the update check** — `checkForUpdate` now runs only in TUI mode; headless runs no longer keep the event loop alive up to 5 s for a banner only the TUI renders.

## Implemented (code review fixes, 2026-06)

- ✅ **`workDir` in `RunOptions`** — `.executant-cancel` is now checked next to the workflow YAML (`dirname(resolve(filePath))`) rather than fixed to `process.cwd()` at module load time; predictable regardless of invocation directory.
- ✅ **`lastStepOutput` on `continueOnError` failures** — `workflow:complete.lastOutput` now always reflects the last _executed_ step (including failing `continueOnError` steps), not the last _successful_ step.
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
