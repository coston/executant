# Product Spec

## What Is Executant

Executant is a CLI workflow runner for developers who use Claude Code. You define a workflow as a YAML file — a sequence of steps that are either AI prompts or bash commands — and `executant` runs them in order with a live TUI showing progress, output, and elapsed time.

## Who It's For

**Primary user:** A developer who runs Claude Code regularly and wants to automate multi-step AI-assisted tasks. They know their tools, are comfortable with YAML and the terminal, and want to spend less time supervising repetitive workflows.

**Representative use cases:**

- Convert a legacy codebase to TypeScript, validate the result, run tests
- Generate a feature implementation from a spec file, then run lint + tests
- Audit every file in a directory and emit a report

## Design Principles

**1. YAML as the interface.** The workflow definition is a plain YAML file. No code required. Steps describe what to do, not how to orchestrate it.

**2. Zero configuration.** Sensible defaults for everything: self-healing is off by default (opt-in per step), judge retry limit is 5, tools default to the standard safe set. Override only when needed.

**3. Transparent execution.** The TUI shows every step's status, live output, and elapsed time. Nothing happens silently. CI mode (`--ci`) emits NDJSON for scripting.

**4. Composable quality controls.** Self-healing and LLM-as-judge are opt-in per step. They compose: a step can be self-healing _and_ judge-evaluated.

**5. Non-destructive on failure.** If a workflow fails, the YAML file stays in `tasks/todo/` so it can be retried unchanged. Completed runs move to `tasks/done/` with a timestamp prefix.

## Feature Set

### Workflow Execution

- Sequential step execution with fail-fast semantics
- `continue_on_error: true` for non-critical steps
- `--step <name|index>` to run a single step
- `--from-step <n>` to resume from a step

### Step Types

- **prompt** — runs Claude with full tool access (or a restricted `allowed_tools` list)
- **script** — runs bash directly (no AI cost)
- **log** — emits a plain progress marker
- **forEach** — repeats one or more child steps for each item in a list or shell command output; use a `steps:` array on the forEach step to run multiple child steps per iteration; `repeat: N` is shorthand for a forEach with a generated numeric list `["1"..."N"]` — `{{item}}` gives the 1-based iteration number in all child steps

### Quality Controls

- **`llm_as_judge`** — evaluates step output and retries on FAIL (up to 5x)
- **`self_healing`** — auto-repairs failed script steps via Claude (up to 5x)

### Context Injection

- **`vars`** — shared key/value pairs substituted as `{{var_name}}`
- **`context`** — injects file contents into a prompt at runtime
- **`output`** — captures a script step's stdout to a file

### TUI Controls

- **`i` — interjection** — opens a text input at the bottom of the screen. The typed message is queued and prepended as `[User correction from a previous step]` to the next Claude step's prompt. If a Claude step is currently running, the message waits for the next Claude step (the Claude CLI processes each invocation as a complete unit; mid-execution injection is not possible). If a script step is running, the message is similarly deferred. Press Esc to cancel without sending.
- **`q` / Ctrl+C** — abort the workflow immediately

### Tooling

- **`executant plan`** — generates a workflow YAML from a natural language description
- **`executant refine`** — applies natural language instructions to an existing workflow YAML
- **`executant update`** — upgrades to the latest version
- **`--ci`** — headless mode, NDJSON event stream to stdout

### Observability

- **OpenTelemetry export** — set `OTEL_EXPORTER_OTLP_ENDPOINT` and every run exports one trace (a root span, a span per step, a span per forEach iteration — annotated with tool, self-healing, and judge activity plus API cost) and step-level metrics to an OTLP/HTTP collector
- **Trace context propagation** — every subprocess a step spawns inherits `TRACEPARENT`, so instrumented tools inside your scripts join the run's trace

This extends design principle 3 (transparent execution) beyond the terminal while honoring principle 2 (zero configuration): a single env var is the only switch, and when it is unset the OTel SDK is never even loaded. The exported data lives in your collector, not in executant — runs remain independent, with no persistent state between them.

## Non-Goals

- Parallel step execution (steps are intentionally sequential)
- Multi-agent coordination (each step is a single Claude session)
- Persistent state between runs (each run is independent)
- A graphical UI (the TUI is terminal-only)
