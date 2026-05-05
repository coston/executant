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
runWorkflow()  ──► AsyncGenerator<Event>  ◄── runner.ts
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

**`src/tasks/claude.ts`** — Spawns the Claude CLI as a child process and streams its NDJSON output as `Event`s. Handles tool call parsing, cost events, and structured output (`output:structured`). `runClaude(task: ClaudeTask)` is the low-level generator; `runClaudeStructured<T>(task, schema)` is a typed wrapper that passes a Zod schema as `--json-schema` and validates the result. `ClaudeTask` carries four internal runtime fields not present in YAML: `permissionMode` (defaults to `'bypassPermissions'`), `jsonSchema` (JSON Schema object for `--json-schema`), `appendSystemPrompt` (text appended via `--append-system-prompt`), and `model` (model override via `--model`).

**`src/tasks/command.ts`** — Spawns a bash subprocess and streams stdout/stderr as `output:text` events. Exports `CommandError`, a typed error class that carries `exitCode` and `command` fields; `runner.ts` uses `instanceof CommandError` to extract the exit code when building `step:error` events.

**`src/tasks/stream.ts`** — Shared stream utilities: `AsyncQueue` (race-condition-free async queue), `mergeStreamsToLines` (merges multiple Readable streams into a line iterator), and `waitForExit`.

**`src/logger.ts`** — Subscribes to the event stream via `withLogger()`. Writes timestamped log files and highlight files (judge verdicts, self-healing activations, complex tool sequences) to `.claude/executant.local/logs/`.

**`src/retrospective.ts`** — Post-execution self-improvement. Reads highlight files from the logger, calls Claude with the retrospective prompt, and saves an improved task YAML to `tasks/backlog/`.

**`src/plan.ts`** — The `executant plan` subcommand. Generates a workflow YAML from a natural language description by calling `runClaude()` (the same path as all other steps — no direct `spawn`). `streamPlan()` is an async generator that streams `PlanEvent`s to the TUI, validates the structured output via Zod, and writes the YAML file. Retries up to 3 times with corrective feedback on parse or schema errors.

**`src/ui/reducer.ts`** — Pure reducer function. Transforms `Event`s into `ExecutionState` for the TUI. No side effects.

**`src/ui/App.tsx`** — Root Ink component. Subscribes to the event stream in a `useEffect`, feeds events into `useReducer`, and renders `ExecutionState`.

**`src/lib/utils.ts`** — Shared pure utilities: `extractJsonObject` (extracts the first complete JSON object from text that may contain prose or markdown fences), `slugify`, `formatTimestamp`, and `timestamp`.

### Cached constants in `runner.ts`

Three prompt files are read once at module load time and stored as module-level constants (`JUDGE_RETRY_CONTEXT`, `SELF_HEALING_PROMPT`, `JUDGE_EVALUATION_PROMPT`). This avoids repeated `readFileSync` calls on the hot path and makes the files' role in the module explicit.

### `forEach` per-iteration abort semantics

When a `forEach` step is running, a failure in any single iteration propagates out of the inner `runStep` call and aborts all remaining iterations. The error then surfaces to `runWorkflow`'s outer try/catch, which checks `continueOnError` on the **forEach step** (not the inner step) to decide whether to continue the workflow. Setting `continue_on_error: true` on the forEach step therefore means: *"if any iteration fails, skip the rest and carry on to the next workflow step."*

## Why Async Generators

The runner is an async generator (`async function*`) for three reasons:

1. **Pure and testable** — tests collect all events into an array with `for await (const e of runWorkflow(wf)) events.push(e)`. No mocking required.
2. **Naturally sequential** — `yield*` composes steps without callbacks or queues.
3. **UI-agnostic** — the same generator feeds the Ink TUI, CI NDJSON output, and tests without modification.

## Event Contract

All communication between the runner and consumers uses the `Event` discriminated union (defined in `src/types.ts`). Every module boundary is typed; there are no raw strings passed between layers.

Key event types in the union:
- `workflow:start` / `workflow:complete` — workflow lifecycle
- `step:start` / `step:complete` / `step:error` / `step:skip` / `step:iteration` — step lifecycle
- `output:text` — plain text line from a command or Claude's text blocks
- `output:tool` — structured tool invocation emitted by Claude
- `output:cost` — API cost reported at the end of a Claude invocation
- `output:structured` — schema-validated JSON object from a Claude invocation that used `--json-schema`
- `log` — informational messages from the runner itself

## Prompt Templates

Large text passed to Claude lives in `src/prompts/*.txt`. They use `{{PLACEHOLDER}}` substitution and are loaded with `readFileSync` at call time. The prompts directory is copied into `dist/` at bundle time.

## Quality Control Features

- **LLM-as-judge** (`llm_as_judge: true`) — after a step completes, a separate Claude call evaluates output quality. On `FAIL`, the step retries with feedback appended, up to 5 times.
- **Self-healing** (`self_healing: true`) — on script failure, error output is passed to Claude for diagnosis. Claude applies a fix and the command re-runs, up to 5 times.
- **Self-improvement** (`self_improve: true`) — after the entire workflow finishes, Claude reviews execution highlights and saves an improved YAML to `tasks/backlog/`.
