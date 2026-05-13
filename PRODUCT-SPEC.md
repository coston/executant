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

**4. Composable quality controls.** Self-healing, LLM-as-judge, and self-improvement are opt-in per step. They compose: a step can be self-healing *and* judge-evaluated.

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
- **forEach** — repeats an inner step for each item in a list or shell command output; `repeat: N` is shorthand for a forEach with a generated numeric list `["1"..."N"]` — `{{item}}` gives the 1-based iteration number

### Quality Controls
- **`llm_as_judge`** — evaluates step output and retries on FAIL (up to 5x)
- **`self_healing`** — auto-repairs failed script steps via Claude (up to 5x)
- **`self_improve`** — post-run retrospective generates an improved workflow YAML

### Context Injection
- **`vars`** — shared key/value pairs substituted as `{{var_name}}`
- **`context`** — injects file contents into a prompt at runtime
- **`output`** — captures a script step's stdout to a file

### Tooling
- **`executant plan`** — generates a workflow YAML from a natural language description
- **`executant update`** — upgrades to the latest version
- **`--ci`** — headless mode, NDJSON event stream to stdout

## Non-Goals

- Parallel step execution (steps are intentionally sequential)
- Multi-agent coordination (each step is a single Claude session)
- Persistent state between runs (each run is independent)
- A graphical UI (the TUI is terminal-only)
