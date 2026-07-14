# Architecture

## Overview

Executant is a TypeScript CLI that runs YAML-defined workflows with Claude Code. Its core design principle is a **pure event stream**: the runner emits typed events, the UI consumes them, and nothing is coupled to each other.

## Data Flow

```
YAML file
   │
   ▼
loadWorkflow() ──► Workflow (typed)
   │
   ▼
runWorkflow(workflow, options, channel?)  ◄── runner.ts
   │    ╰── InterjectChannel (optional)  ◄── types.ts  ◄── App.tsx (user keypress)
   │
   ├──► Logger.observe(event)             ◄── logger.ts (side-channel observer)
   │
   ├──► Telemetry.observe(event)          ◄── telemetry.ts (OTel spans + metrics; opt-in)
   │
   ▼
useReducer(reducer, event)               ◄── ui/reducer.ts
   │
   ▼
Ink TUI render                           ◄── ui/App.tsx
```

In CI mode (`--ci`), the event stream is serialized as NDJSON to stdout instead of being rendered by Ink. The stream is additive over time — new event types (most recently `step:healing` and `step:judge`) and fields (a step `index` on `output:cost`) may appear — so NDJSON consumers should tolerate unknown event types and fields.

## Module Responsibilities

**`src/index.ts`** — CLI entry point. Parses arguments (`--ci`, `--step`, `--from-step`, `--var KEY=VALUE`), selects between TUI and CI output modes, handles the `plan` and `update` subcommands, auto-creates `tasks/todo` and `tasks/done` directories on startup, and wires the runner to the logger (and, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the telemetry observer — flushed via `telemetry.shutdown()` on every exit path, including a SIGINT handler that is registered only when telemetry is on). Exit codes: 0 success, 1 runtime failure, 2 YAML/var validation, 3 timeout, 4 cancelled.

**`src/runner.ts`** — Pure async generator. Accepts a `Workflow` and yields `Event`s. Owns all quality-control logic: step filtering, forEach iteration, self-healing retry loops, and LLM-as-judge evaluation. Checks for a `.executant-cancel` file at the start of each step loop iteration; if present, deletes it and emits `workflow:cancelled`. Collects up to 100 lines of `output:text` per step and includes them as `lastOutput` on `step:error` and `workflow:complete` events. Has no knowledge of the UI.

**`src/load-workflow.ts`** — Parses YAML into a typed `Workflow`. Validates the schema, resolves `vars`, infers step types, and wires up `context:`, `output:`, and `timeout_seconds:` fields. Accepts an optional `cliVars` parameter that is merged over YAML vars (CLI overrides YAML) before placeholder substitution.

**`src/tasks/agent.ts`** — Provider dispatch layer. `resolveAgentProvider(task)` resolves the provider in this order: (1) `task.provider` field, (2) `EXECUTANT_PROVIDER` env var, (3) `"claude"` default. `resolveAgentModel(task)` resolves the model the same way (`task.model`, then `EXECUTANT_MODEL`, else `undefined` — the provider CLI's default); it is shared by both backends and by the telemetry span attributes. `runAgent(task)` and `runAgentStructured(task, schema)` route to the appropriate backend and are the only entry points used by `runner.ts`, `plan.ts`, and `refine.ts`. Adding a new provider requires only a new case in each switch and a new `src/tasks/<provider>.ts` file.

**`src/tasks/claude.ts`** — Spawns the Claude CLI as a child process and streams its NDJSON output as `Event`s. Handles tool call parsing, cost events, and structured output (`output:structured`). `runClaude(task: ClaudeTask)` is the low-level generator. `runClaudeStructured<T>(task, schema)` is a typed wrapper that passes a Zod schema as `--json-schema` and validates the result. Exports `METHODOLOGY` (the development loop loaded from `src/prompts/development-methodology.txt`) and `buildClaudeArgs(task, interactive?)` (pure function constructing the CLI args array, exported for testing). `ClaudeTask` carries runtime fields not present in YAML: `provider` (optional — routes through `agent.ts` dispatch), `permissionMode`, `jsonSchema`, `appendSystemPrompt`, `model`, and `agent` (OpenCode `--agent` flag). The spawn env includes `traceparentEnv()` from `src/lib/trace-context.ts`, so the subprocess inherits `TRACEPARENT` when telemetry is active.

**`src/tasks/opencode.ts`** — Spawns the OpenCode CLI (`opencode run --format json`) and streams its JSON events as `Event`s. `buildOpenCodeArgs(task)` constructs the args array (model from `task.model` then `EXECUTANT_MODEL` env; agent from `task.agent` then `EXECUTANT_AGENT` env; `--dangerously-skip-permissions` for `bypassPermissions` mode). `buildOpenCodePermissionEnv(allowedTools)` translates the `allowed_tools` step field into the `OPENCODE_PERMISSION` env var: `undefined` → no env set (all tools allowed); `[]` → deny all tools (text-only mode); `["bash","read"]` → deny every tool not in the list. Tool names are matched case-insensitively so Claude-style names (`Bash`, `Read`) and opencode-style names (`bash`, `read`) both work. `parseOpenCodeMessage(msg)` normalises OpenCode's event types (`text`, `tool_use`, `error`) to Executant's `output:text` and `output:tool` events. `runOpenCodeStructured` appends a JSON-only instruction to the prompt and parses the response via `extractJsonObject`. The spawn env includes `traceparentEnv()` alongside `OPENCODE_PERMISSION`.

**`src/tasks/command.ts`** — Spawns a bash subprocess and streams stdout/stderr as `output:text` events. Exports `CommandError`, a typed error class that carries `exitCode` and `command` fields. Supports per-step `timeoutSeconds` via the shared `startTimeout` helper from `stream.ts`. The spawn env includes `traceparentEnv()`, so scripts inherit `TRACEPARENT` when telemetry is active.

**`src/tasks/stream.ts`** — Shared stream utilities: `AsyncQueue` (race-condition-free async queue), `mergeStreamsToLines` (merges multiple Readable streams into a line iterator), and `waitForExit`.

**`src/logger.ts`** — Subscribes to the event stream via `withLogger()`. Writes timestamped log files to `.claude/executant.local/logs/`. Exports the `Observer` interface (`{ observe(event) }`) that both the logger and the telemetry observer implement, so `withLogger()` doubles as a generic tee.

**`src/telemetry.ts`** — Opt-in OpenTelemetry observer (an `Observer`, teed into the event stream with the same `withLogger()` as the file logger). `createTelemetry()` returns `null` when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset — before importing anything; all `@opentelemetry/*` imports are dynamic and live inside it, so the SDK is never loaded when telemetry is off (esbuild preserves external dynamic imports verbatim in the bundle). A reducer-style state machine (mirroring `logger.ts`) folds the event stream into one trace per run — an `executant.run` root span with a child span per step (index/type/provider/model/cost attributes; `tool`/`healing`/`judge` span events; tool inputs and `output:text` lines are never recorded as span events, though a failed step's error message — which can quote its final output lines — is recorded via the exception event, truncated to 1,000 chars) and grandchild spans per top-level forEach iteration — plus five metrics (step duration/errors, cost by provider, healing attempts, judge verdicts). On `step:start` it publishes the step span's context to the trace-context registry; `shutdown()` is idempotent, ends any still-open spans with `executant.aborted=true` (stamping the accumulated cost attributes first), flushes both providers, and is hard-capped at ~3 s — the OTLP exporters' own request timeout is set to the same ~3 s, so a dead or unresponsive collector can neither hang exit nor keep the event loop alive past the cap.

**`src/plan.ts`** — The `executant plan` subcommand. Generates a workflow YAML from a natural language description by calling `runClaude()` (the same path as all other steps — no direct `spawn`). `streamPlan()` is an async generator that streams `PlanEvent`s to the TUI, validates the structured output via Zod, and writes the YAML file. Retries up to 3 times with corrective feedback on parse or schema errors. All three plan pipeline passes (research, decompose, judge) inject `METHODOLOGY` via `appendSystemPrompt` so the development loop shapes how plans are structured.

**`src/ui/reducer.ts`** — Pure reducer function. Transforms `Event`s into `ExecutionState` for the TUI. No side effects. `step:iteration` events append an `IterationRecord` to `TaskState.iterationHistory`; `step:inner` updates the running record's child-step metadata; `step:complete`/`step:error` finalise the last running record. `step:interjection` appends `[interjection] <message>` to the current task's log lines.

**`src/ui/App.tsx`** — Root Ink component. Subscribes to the event stream in a `useEffect`, feeds events into `useReducer`, and renders `ExecutionState`. forEach steps expand into `IterationList` sub-rows while running (capped at 8 with an "… N earlier" indicator). Holds `isInterjecting` state: when `i` is pressed, renders `InterjectInput` below the log pane; on submit, calls `interjectChannel.interject(message)` and dispatches `step:interjection` to the reducer.

**`src/ui/InterjectInput.tsx`** — Text input overlay rendered when `isInterjecting` is true. Uses Ink's `useInput` to capture keystrokes (backspace, Esc, Enter). Shows `▷ <typed text>▌  esc to cancel`. On Enter submits the non-empty value; on Esc cancels without sending.

**`src/ui/IterationRow.tsx`** — `IterationRow` renders a single `IterationRecord` (item name, optional child-step progress, elapsed time, spinner/icon). `IterationList` wraps a slice of the history array and prepends the truncation indicator when needed.

**`src/lib/utils.ts`** — Shared pure utilities: `extractJsonObject` (extracts the first complete JSON object from text that may contain prose or markdown fences), `slugify`, `formatTimestamp`, and `timestamp`.

**`src/lib/trace-context.ts`** — Module-level registry holding the current W3C traceparent string, deliberately free of OpenTelemetry imports (plain strings only). The telemetry observer sets it synchronously on `step:start` — the runner is suspended at `yield` until the consumer pulls the next event, so the value is guaranteed in place before the step spawns. `traceparentEnv()` returns `{ TRACEPARENT }` when set and `{}` otherwise, so every spawn site (claude, opencode, command, and the runner's forEach item-resolution shell) spreads it into the child env with zero effect when telemetry is off.

**`src/version.ts`** — Single source for `CURRENT_VERSION`, read from `package.json` relative to the file (the `../package.json` hop resolves identically in tsx dev and in the esbuild bundle). Imported by `index.ts` (update checks, help output) and `telemetry.ts` (the `service.version` resource attribute).

### Exit codes

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| `0`  | All steps completed successfully                                    |
| `1`  | A step failed at runtime                                            |
| `2`  | YAML or variable validation error (from `loadWorkflow`)             |
| `3`  | A step timed out (`TimeoutError` from `timeout_seconds`)            |
| `4`  | Cancelled via `.executant-cancel` file (`workflow:cancelled` event) |

### Cancellation

`runWorkflow()` checks for a `.executant-cancel` file at the start of each step loop iteration. The file path is resolved from `options.workDir` (defaults to `process.cwd()`). In production, `index.ts` passes `workDir: dirname(resolve(filePath))` so the cancel file is always checked next to the workflow YAML, regardless of which directory executant was invoked from. If found, the file is deleted and a `workflow:cancelled` event is emitted, then the generator returns. In CI mode, the runner writes the event and exits with code 4 only after stdout is flushed (via write callback). In TUI mode, `App.tsx` handles `workflow:cancelled` by setting `process.exitCode = 4` and calling Ink's `exit()`.

### `lastOutput` on events

`step:error` and `workflow:complete` both carry an optional `lastOutput?: string` field: up to the last 100 lines of `output:text` from that step, joined with newlines. The runner uses a fixed-size ring buffer (shift-on-overflow) during execution, so memory cost is constant regardless of step verbosity. `workflow:complete.lastOutput` always reflects the last _executed_ step — including a step that failed with `continue_on_error: true` — not merely the last _successful_ step.

### `startTimeout` helper (`src/tasks/stream.ts`)

Both `runCommand` and `runClaude` support per-step timeouts via the shared `startTimeout(proc, taskName, timeoutSeconds)` helper exported from `stream.ts`. It arms a `setTimeout` that sets a `timedOut` flag and kills the process if the deadline elapses. The caller calls `timeout.check()` after `waitForExit()` to throw `TimeoutError` if timed out, and `timeout.cancel()` in `finally` to clear the timer on normal completion. The single-threaded event loop guarantees no race: `clearTimeout` in `finally` runs synchronously before any macrotask can fire the callback.

### Cached constants in `runner.ts`

Three prompt files are read once at module load time and stored as module-level constants (`JUDGE_RETRY_CONTEXT`, `SELF_HEALING_PROMPT`, `JUDGE_EVALUATION_PROMPT`). This avoids repeated `readFileSync` calls on the hot path and makes the files' role in the module explicit.

### `forEach` per-iteration abort semantics

When a `forEach` step is running, a failure in any single iteration propagates out of the inner `runStep` call and aborts all remaining iterations. The error then surfaces to `runWorkflow`'s outer try/catch, which checks `continueOnError` on the **forEach step** (not the inner step) to decide whether to continue the workflow. Setting `continue_on_error: true` on the forEach step therefore means: _"if any iteration fails, skip the rest and carry on to the next workflow step."_

For multi-step forEach (using the `steps:` key), each child step has its own `continueOnError`. If a child step fails with `continue_on_error: true`, only that child is skipped and the next child in the same iteration runs. If a child step fails without `continue_on_error`, the error propagates out of the entire loop — remaining children in the current iteration and all subsequent iterations are abandoned, and the outer `continueOnError` on the forEach step determines whether the workflow continues.

## Why Async Generators

The runner is an async generator (`async function*`) for three reasons:

1. **Pure and testable** — tests collect all events into an array with `for await (const e of runWorkflow(wf)) events.push(e)`. No mocking required.
2. **Naturally sequential** — `yield*` composes steps without callbacks or queues.
3. **UI-agnostic** — the same generator feeds the Ink TUI, CI NDJSON output, and tests without modification.

## Event Contract

All communication between the runner and consumers uses the `Event` discriminated union (defined in `src/types.ts`). Every module boundary is typed; there are no raw strings passed between layers.

Key event types in the union:

- `workflow:start` / `workflow:complete` — workflow lifecycle
- `step:start` / `step:complete` / `step:error` / `step:skip` / `step:iteration` / `step:inner` — step lifecycle (`step:iteration` fires at the start of each forEach/repeat iteration; `step:inner` fires before each child step when there are multiple child steps per iteration). The reducer accumulates these into `TaskState.iterationHistory` (`IterationRecord[]`) so the TUI can show per-iteration progress.
- `step:interjection` — dispatched directly by `App.tsx` (not the runner) when the user submits an interjection via the `i` key. Carries `index` (current step) and `message`. Handled by the reducer to append a log line; not emitted on the async generator.
- `step:healing` — structured progress from the self-healing loop: `phase` (`attempt-failed` / `healed` / `exhausted`), 1-based `attempt`, `maxAttempts`, and `exitCode` on failure phases. Emitted alongside (not replacing) the free-text `log` events, which remain the TUI/logfile rendering.
- `step:judge` — emitted after each LLM-as-judge evaluation: `verdict` (`pass` / `fail`), 1-based `attempt`, `maxAttempts`, and `feedback` on fail.
- `output:text` — plain text line from a command or Claude's text blocks
- `output:tool` — structured tool invocation emitted by Claude
- `output:cost` — API cost reported at the end of a Claude invocation. Carries the 0-based step `index`: inner generators emit a `-1` sentinel that `runWorkflow` patches to the real step index (the same patching applies to `step:healing` and `step:judge`).
- `output:structured` — schema-validated JSON object from a Claude invocation that used `--json-schema`
- `log` — informational messages from the runner itself

## Prompt Templates

Large text passed to Claude lives in `src/prompts/*.txt`. They use `{{PLACEHOLDER}}` substitution and are loaded with `readFileSync` at call time. The prompts directory is copied into `dist/` at bundle time.

## Eval System (Internal Dev Tooling)

The eval system tests and iteratively refines the prompt templates in `src/prompts/`. It is not user-facing — run via `npm run eval` during development.

**`src/eval/index.ts`** — CLI entry point. Parses `--refine`, `--max-iter`, `--models`, `--cases`, `--output-json`, and `--output-csv` flags. Accepts one or more eval file paths as positional arguments. `--cases` accepts comma-separated case IDs or 1-based index ranges (e.g. `simple,1-3`) to run a subset without editing YAML. Single-model mode: loads existing CSV results for resume (skips already-scored cases), runs remaining cases, optional refine loop. Multi-model mode (2+ models via `--models`): runs each model independently, builds an `EvalComparison`, prints a side-by-side table. When multiple files are passed, output paths are auto-suffixed per eval name.

**`src/eval/load.ts`** — Parses `evals/*.eval.yaml` via Zod. Resolves fixture paths (values in `vars` that end in `.md` / `.txt` are read and substituted with file contents).

**`src/eval/runner.ts`** — `runPrompt(templatePath, vars, model?)`: substitutes `{{PLACEHOLDER}}` vars, runs the prompt through the specified model via `runAgent`, and returns the raw text output. Claude receives `METHODOLOGY` as `appendSystemPrompt`; OpenCode does not (flag not supported).

**`src/eval/judge.ts`** — `judgeOutput()`: takes a single output string and a criterion string, always uses Claude for judgment (the authoritative judge), and returns `{ pass: boolean, reason: string }`.

**`src/eval/refine.ts`** — `refinePrompt()`: given the current template and a list of failures, calls Claude with the prompt-refiner prompt and returns a rewritten template.

**`src/eval/report.ts`** — Terminal output: `printRun()` for single-model pass/fail table; `printComparison()` for multi-model side-by-side comparison table.

**`src/eval/export.ts`** — `toJson(comparison)` and `toCsv(comparison)`: serialize `EvalComparison` for benchmark analysis. CSV is denormalized (one row per criterion judgment per model) with columns `eval_name, template_path, case_id, criterion, model_label, provider, model, pass, reason, duration_ms`.

**`src/eval/prompts/`** — Eval-specific prompts (`criterion-judge.txt`, `prompt-refiner.txt`). Same `{{PLACEHOLDER}}` convention as `src/prompts/`.

**`evals/`** — Eval YAML definitions and `fixtures/` subdirectory with reusable input documents. Covers prompt-quality evals (`plan-decompose`, `judge-evaluation`, `self-healing-fix`, `plan-judge`, `development-methodology`) and benchmark evals (`code-generation-quality`, `code-review-depth`, `instruction-following-precision`, `structured-output-reliability`, `methodology-context-sensitivity`).

## Workflow Eval System

Tests end-to-end model capability on real coding tasks, not just prompt quality. Each task runs the full development lifecycle in an isolated git worktree.

**Two-phase design:**

```
Phase 1 — Model execution (in git worktree):
  explore → writes research.md to .eval/
  plan    → reads research.md via context:, writes plan.md
  implement → reads both via context:, edits src/
  test    → npm test (self_healing: true)
  commit  → git commit

Phase 2 — Eval harness (always Claude as judge, never the model):
  git diff HEAD -- src/ tests/
  judgeAllCriteria(diff, eval_criteria)
  → WorkflowComparison table
```

**`src/eval/workflow.ts`** — `runWorkflowEval(taskPath, models)`: creates an isolated git worktree per model (with a `node_modules` symlink), spawns executant `--ci` in the worktree with the model's env vars, then uses Claude to judge the resulting diff against `eval_criteria`.

**`src/eval/workflow-report.ts`** — `printWorkflowComparison()`: per-model table showing tests pass/fail, judge score, diff stats, and duration. `toWorkflowCsv()` for export.

**`src/eval/workflow-index.ts`** — CLI: `npm run eval:workflow -- --models claude/sonnet evals/workflow/add-workflow-description.yaml`

### Refinement loop

```
score all cases
   │
   ├─ all pass? → done
   │
   └─ failures → refinePrompt() → overwrite src/prompts/<name>.txt → re-score
                                                   (up to --max-iter, default 5)
```

## Interjection

The interjection feature lets users send a correction to a running workflow by pressing `i` in the TUI.

**`InterjectChannel`** (defined in `src/types.ts`) bridges the TUI and the runner:

- `interject(message)` — called by `App.tsx` on user submit. Queues the message for the next Claude step.
- `consumeQueue()` — called by `runStep` at the start of each Claude step. Drains and returns any queued messages, which are prepended to the prompt.

**Delivery path for queued messages:** `runStep` (case `"claude"`) calls `channel.consumeQueue()` before building the task. If messages are present they are prepended to the prompt as `[User correction from a previous step]\n<messages>\n\n---\n<original prompt>`.

**Why stdin injection doesn't work:** The Claude CLI (without `--print`) reads stdin until EOF before processing the input. Keeping stdin open while waiting for potential interjections causes Claude to hang — it never processes the prompt. Tested and confirmed: `{ printf "prompt\n"; sleep 5; } | claude` produces no response. True mid-step injection would require killing and resuming the subprocess with accumulated context, which is a future capability.

**`buildClaudeArgs(task, interactive?)`** accepts an `interactive` flag that omits `--print` from the returned args. This is retained for testability (the test suite validates the interactive-mode args contract) but is not used in the production code path — `runClaude` always passes `interactive=false` (the default).

## Quality Control Features

- **LLM-as-judge** (`llm_as_judge: true`) — after a step completes, a separate Claude call evaluates output quality. On `FAIL`, the step retries with feedback appended, up to 5 times. Each evaluation emits a structured `step:judge` event alongside the free-text logs.
- **Self-healing** (`self_healing: true`) — on script failure, error output is passed to Claude for diagnosis. Claude applies a fix and the command re-runs, up to 5 times. Each phase of the loop emits a structured `step:healing` event alongside the free-text logs.

## Local Model Inference (Dev Tooling)

These scripts are internal dev tooling for running multi-model eval comparisons. They are not part of the published package.

**`src/lib/model-config.ts`** — Shared model registry: `MODELS_DIR` (`~/.executant/models/`), `PIDS_DIR` (`~/.executant/pids/`), and the `MODELS` array defining each model's name, key, file, port, download URL, and size. Imported by `native-models.ts`, `model-server.ts`, `setup.ts`, and the dependency tests.

**`src/native-models.ts`** — Downloads GGUF model files to `~/.executant/models/` using native `curl`. Idempotent: present files are skipped. Run via `npm run models:download`.

**`src/model-server.ts`** — Manages native `llama-server` processes (Apple Silicon Metal GPU). `start` spawns detached processes with `-ngl 999`, writes PIDs to `~/.executant/pids/`. `stop` kills by PID. `status` cross-references live PID with HTTP health check. Exports `isServerHealthy(port)`. The CLI entry point is guarded by an `isMain` check so the file is safe to import. Run via `npm run models:start|stop|status`.
