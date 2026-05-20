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
   ▼
useReducer(reducer, event)               ◄── ui/reducer.ts
   │
   ▼
Ink TUI render                           ◄── ui/App.tsx
```

In CI mode (`--ci`), the event stream is serialized as NDJSON to stdout instead of being rendered by Ink.

## Module Responsibilities

**`src/index.ts`** — CLI entry point. Parses arguments, selects between TUI and CI output modes, handles the `plan` and `update` subcommands, and wires the runner to the logger.

**`src/runner.ts`** — Pure async generator. Accepts a `Workflow` and yields `Event`s. Owns all quality-control logic: step filtering, forEach iteration, self-healing retry loops, and LLM-as-judge evaluation. Has no knowledge of the UI.

**`src/load-workflow.ts`** — Parses YAML into a typed `Workflow`. Validates the schema, resolves `vars`, infers step types, and wires up `context:` and `output:` fields.

**`src/tasks/claude.ts`** — Spawns the Claude CLI as a child process and streams its NDJSON output as `Event`s. Handles tool call parsing, cost events, and structured output (`output:structured`). `runClaude(task: ClaudeTask, _channel?: InterjectChannel)` is the low-level generator; the `channel` parameter is accepted for API compatibility but is not used for stdin injection — the Claude CLI requires stdin EOF before processing a piped prompt, making mid-execution injection impossible. Interjections are instead queued by `InterjectChannel` and prepended to the next Claude step's prompt in `runner.ts`. `runClaudeStructured<T>(task, schema)` is a typed wrapper that passes a Zod schema as `--json-schema` and validates the result. Exports `METHODOLOGY` (the development loop loaded from `src/prompts/development-methodology.txt`) and `buildClaudeArgs(task, interactive?)` (pure function constructing the CLI args array, exported for testing; `interactive=true` omits `--print` from the returned args but is not used by the production path). `ClaudeTask` carries four internal runtime fields not present in YAML: `permissionMode` (defaults to `'bypassPermissions'`), `jsonSchema` (JSON Schema object for `--json-schema`), `appendSystemPrompt` (text appended via `--append-system-prompt`), and `model` (model override via `--model`).

**`src/tasks/command.ts`** — Spawns a bash subprocess and streams stdout/stderr as `output:text` events. Exports `CommandError`, a typed error class that carries `exitCode` and `command` fields; `runner.ts` uses `instanceof CommandError` to extract the exit code when building `step:error` events.

**`src/tasks/stream.ts`** — Shared stream utilities: `AsyncQueue` (race-condition-free async queue), `mergeStreamsToLines` (merges multiple Readable streams into a line iterator), and `waitForExit`.

**`src/logger.ts`** — Subscribes to the event stream via `withLogger()`. Writes timestamped log files and highlight files (judge verdicts, self-healing activations, complex tool sequences) to `.claude/executant.local/logs/`.

**`src/retrospective.ts`** — Post-execution self-improvement. Reads highlight files from the logger, calls Claude with the retrospective prompt, and saves an improved task YAML to `tasks/backlog/`.

**`src/plan.ts`** — The `executant plan` subcommand. Generates a workflow YAML from a natural language description by calling `runClaude()` (the same path as all other steps — no direct `spawn`). `streamPlan()` is an async generator that streams `PlanEvent`s to the TUI, validates the structured output via Zod, and writes the YAML file. Retries up to 3 times with corrective feedback on parse or schema errors. All three plan pipeline passes (research, decompose, judge) inject `METHODOLOGY` via `appendSystemPrompt` so the development loop shapes how plans are structured.

**`src/ui/reducer.ts`** — Pure reducer function. Transforms `Event`s into `ExecutionState` for the TUI. No side effects. `step:iteration` events append an `IterationRecord` to `TaskState.iterationHistory`; `step:inner` updates the running record's child-step metadata; `step:complete`/`step:error` finalise the last running record. `step:interjection` appends `[interjection] <message>` to the current task's log lines.

**`src/ui/App.tsx`** — Root Ink component. Subscribes to the event stream in a `useEffect`, feeds events into `useReducer`, and renders `ExecutionState`. forEach steps expand into `IterationList` sub-rows while running (capped at 8 with an "… N earlier" indicator). Holds `isInterjecting` state: when `i` is pressed, renders `InterjectInput` below the log pane; on submit, calls `interjectChannel.interject(message)` and dispatches `step:interjection` to the reducer.

**`src/ui/InterjectInput.tsx`** — Text input overlay rendered when `isInterjecting` is true. Uses Ink's `useInput` to capture keystrokes (backspace, Esc, Enter). Shows `▷ <typed text>▌  esc to cancel`. On Enter submits the non-empty value; on Esc cancels without sending.

**`src/ui/IterationRow.tsx`** — `IterationRow` renders a single `IterationRecord` (item name, optional child-step progress, elapsed time, spinner/icon). `IterationList` wraps a slice of the history array and prepends the truncation indicator when needed.

**`src/lib/utils.ts`** — Shared pure utilities: `extractJsonObject` (extracts the first complete JSON object from text that may contain prose or markdown fences), `slugify`, `formatTimestamp`, and `timestamp`.

### Cached constants in `runner.ts`

Three prompt files are read once at module load time and stored as module-level constants (`JUDGE_RETRY_CONTEXT`, `SELF_HEALING_PROMPT`, `JUDGE_EVALUATION_PROMPT`). This avoids repeated `readFileSync` calls on the hot path and makes the files' role in the module explicit.

### `forEach` per-iteration abort semantics

When a `forEach` step is running, a failure in any single iteration propagates out of the inner `runStep` call and aborts all remaining iterations. The error then surfaces to `runWorkflow`'s outer try/catch, which checks `continueOnError` on the **forEach step** (not the inner step) to decide whether to continue the workflow. Setting `continue_on_error: true` on the forEach step therefore means: *"if any iteration fails, skip the rest and carry on to the next workflow step."*

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
- `output:text` — plain text line from a command or Claude's text blocks
- `output:tool` — structured tool invocation emitted by Claude
- `output:cost` — API cost reported at the end of a Claude invocation
- `output:structured` — schema-validated JSON object from a Claude invocation that used `--json-schema`
- `log` — informational messages from the runner itself

## Prompt Templates

Large text passed to Claude lives in `src/prompts/*.txt`. They use `{{PLACEHOLDER}}` substitution and are loaded with `readFileSync` at call time. The prompts directory is copied into `dist/` at bundle time.

## Eval System (Internal Dev Tooling)

The eval system tests and iteratively refines the prompt templates in `src/prompts/`. It is not user-facing — run via `npm run eval` during development.

**`src/eval/index.ts`** — CLI entry point. Parses `--refine` and `--max-iter` flags, orchestrates the score → collect-failures → refine → re-score loop, and delegates rendering to `report.ts`.

**`src/eval/load.ts`** — Parses `evals/*.eval.yaml` via Zod. Resolves fixture paths (values in `vars` that end in `.md` / `.txt` are read and substituted with file contents).

**`src/eval/runner.ts`** — `runPrompt()`: substitutes `{{PLACEHOLDER}}` vars into a prompt template, calls Claude with no tools, and returns the raw text output.

**`src/eval/judge.ts`** — `judgeOutput()`: takes a single output string and a criterion string, calls Claude with the criterion-judge prompt, and returns `{ pass: boolean, reason: string }`.

**`src/eval/refine.ts`** — `refinePrompt()`: given the current template and a list of failures (case id + criterion + reason), calls Claude with the prompt-refiner prompt and returns a rewritten template.

**`src/eval/report.ts`** — Terminal output: renders a per-case pass/fail table with criterion reasons.

**`src/eval/prompts/`** — Eval-specific prompts (`criterion-judge.txt`, `prompt-refiner.txt`). Same `{{PLACEHOLDER}}` convention as `src/prompts/`.

**`evals/`** — Eval YAML definitions and `fixtures/` subdirectory with reusable input documents. Covers `plan-decompose.txt`, `judge-evaluation.txt`, `self-healing-fix.txt`, `plan-judge.txt`, and `retrospective-analysis.txt`.

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
- `register(sender)` — called by `runClaude` at step start. Flushes any queued messages via `sender`, then delivers future messages directly.
- `unregister()` — called when a Claude step ends; returns to queueing mode.
- `interject(message)` — called by `App.tsx` on user submit. Delivers to the current sender if one is registered; otherwise queues.
- `consumeQueue()` — called by `runStep` at the start of each Claude step. Drains and returns any messages queued during non-Claude steps.

**Delivery path for queued messages:** `runStep` (case `"claude"`) calls `channel.consumeQueue()` before building the task. If messages are present they are prepended to the prompt as `[User correction from a previous step]\n<messages>\n\n---\n<original prompt>`.

**Why stdin injection doesn't work:** The Claude CLI (without `--print`) reads stdin until EOF before processing the input. Keeping stdin open while waiting for potential interjections causes Claude to hang — it never processes the prompt. Tested and confirmed: `{ printf "prompt\n"; sleep 5; } | claude` produces no response. True mid-step injection would require killing and resuming the subprocess with accumulated context, which is a future capability.

**`buildClaudeArgs(task, interactive?)`** accepts an `interactive` flag that omits `--print` from the returned args. This is retained for testability (the test suite validates the interactive-mode args contract) but is not used in the production code path — `runClaude` always passes `interactive=false` (the default).

## Quality Control Features

- **LLM-as-judge** (`llm_as_judge: true`) — after a step completes, a separate Claude call evaluates output quality. On `FAIL`, the step retries with feedback appended, up to 5 times.
- **Self-healing** (`self_healing: true`) — on script failure, error output is passed to Claude for diagnosis. Claude applies a fix and the command re-runs, up to 5 times.
- **Self-improvement** (`self_improve: true`) — after the entire workflow finishes, Claude reviews execution highlights and saves an improved YAML to `tasks/backlog/`.
