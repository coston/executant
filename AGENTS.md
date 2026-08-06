# Development Guide

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Executant is a TypeScript CLI tool (`src/`) that executes YAML-defined workflows with Claude Code. The `executant` wrapper runs `tsx src/index.ts`. It supports two execution modes: **Claude steps** (AI-assisted) and **script steps** (direct bash execution).

# Agent Rules

1. Avoid leaving script (.sh) files in the repo. Prefer framework integration.
2. Prefer DRY, immutable, functional programming
3. Prefer expressive, declarative constructs (e.g., map/flatMap) over imperative loops. Optimize for performance only when there is clear evidence it matters.
4. Develop in a way that the logic is easy to understand.
5. Every aspect of this application must be tested. The agent must self-prove the implementation works.
6. Prefer defaults over custom config files.
7. Always aim to reduce and simplify the codebase
8. Keep Readme.md, ARCHITECTURE.md, and BACKLOG.md, PRODUCT-SPEC.md up-to-date as things evolve.
9. Always strive for extensive test coverage.
10. Always consider how changes will affect the goals and data integrity of the application. Defend the users.
11. This cli must work on MacOS and Linux

## Core Architecture

### Main Components

1. **Task YAML files** - Workflow definitions
   - `goal`: High-level task description
   - `steps`: Array of step objects with `name` and either `prompt`, `command`, or `message`
   - `vars`: Optional map of key/value pairs substituted as `{{var_name}}` in prompts and commands
   - `type: prompt` (default) - Execute with Claude Code (all tools available)
   - `type: script` - Execute directly with bash (no API cost)
   - `type: log` - Emit a plain text progress marker (no API cost, no command)
   - `continue_on_error: true` - Optional, allows script steps to fail without stopping
   - `self_healing: true` - Optional (defaults to `false`; opt-in per step), automatically passes script failures to Claude for fixing
   - `llm_as_judge: true` - Optional, evaluates step quality and retries up to 5 times if needed
   - `allowed_tools` - Optional list restricting which tools are available for a prompt step. Applies to both Claude and OpenCode providers. Omit entirely for no restrictions (default — all tools available). `[]` = text-only mode (no tools). `[bash, read]` = only those tools. Tool names are case-insensitive (`Bash` and `bash` both work).
   - `context` - Optional list of var names whose values are file paths; file contents are prepended to the prompt at runtime
   - `forEach` - Optional inline array or shell command (newline-split stdout); runs the inner step once per item with `{{item}}` substituted
   - `repeat: N` - Runs the step N times sequentially (compiles to a ForEachTask at load time); mutually exclusive with `forEach`; `{{item}}` is the 1-based iteration number
   - `steps` - Optional array of child steps on a `forEach`/`repeat` step; each iteration runs all child steps in order with `{{item}}` substituted; mutually exclusive with `command`/`prompt`/`message` on the parent step; requires `forEach` or `repeat` to be present
   - `timeout_seconds: N` - Optional; kill the step process after N seconds and throw TimeoutError (exit code 3); works for both script and prompt steps

2. **TypeScript implementation** (`src/`)
   - `src/index.ts` - Entry point: CLI parsing, Ink TUI rendering, CI mode (NDJSON), `plan`/`refine`/`update` subcommands; creates `InterjectChannel` and passes it to both `runWorkflow` and `App`
   - `src/load-workflow.ts` - YAML → typed `Workflow`
   - `src/runner.ts` - Pure async generator yielding `Event`s; self-healing, LLM-as-judge, forEach, context injection; accepts optional `InterjectChannel` and prepends queued interjections to the next Claude step's prompt
   - `src/logger.ts` - Subscribes to event stream; writes `.log` files to `.claude/executant.local/logs/`; exports the `Observer` interface shared with telemetry
   - `src/telemetry.ts` - Opt-in OpenTelemetry observer; exports traces + metrics via OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
   - `src/types.ts` - All shared types: `Task`, `Event` (including the structured `step:healing`/`step:judge` events and the indexed `output:cost` — all emitted with an `index: -1` sentinel that `runWorkflow` patches to the real step index), `Workflow`, `RawWorkflow`/`RawStep` (YAML schema), `InterjectChannel` class

### Module Architecture

#### Directory Structure

```
src/
├── index.ts              # Entry point (CLI, TUI, CI mode, plan/refine/update subcommands)
├── load-workflow.ts      # YAML → typed Workflow
├── runner.ts             # Workflow execution (self-healing, judge, forEach, context)
├── logger.ts             # Execution logger (log files); exports the shared Observer interface
├── telemetry.ts          # Opt-in OpenTelemetry observer (OTLP traces + metrics)
├── plan.ts               # `executant plan` subcommand
├── refine.ts             # `executant refine` subcommand
├── update.ts             # `executant update` upgrade logic
├── types.ts              # All shared types
├── version.ts            # Single source for CURRENT_VERSION (read from package.json)
├── lib/
│   ├── remote-workflow.ts # `executant <url>`: GitHub/gist raw rewrite, gh-token fetch
│   ├── trace-context.ts  # TRACEPARENT registry shared by telemetry + all spawn sites
│   └── utils.ts          # Shared pure utilities (slugify, formatTimestamp, etc.)
├── tasks/
│   ├── agent.ts          # Provider dispatch (resolveAgentProvider, resolveAgentModel)
│   ├── claude.ts         # Claude CLI child process runner
│   ├── command.ts        # Bash command runner
│   ├── opencode.ts       # OpenCode CLI child process runner
│   └── stream.ts         # Shared stream utilities (AsyncQueue, mergeStreamsToLines)
├── ui/                   # Ink TUI components
│   ├── App.tsx           # Root component; holds isInterjecting state; wires InterjectChannel
│   ├── InterjectInput.tsx # Text input overlay shown when user presses i
│   ├── KeyboardHandler.tsx # Handles q/Ctrl+C/i; disabled while isInterjecting
│   ├── PlanApp.tsx        # TUI for plan/refine subcommands
│   ├── TaskRow.tsx        # Renders a single step row
│   ├── IterationRow.tsx   # Renders forEach iteration progress
│   ├── LogPane.tsx        # Scrolling output pane
│   ├── BrandMark.tsx      # Animated brand header
│   └── reducer.ts        # ExecutionState reducer; handles step:interjection event
└── prompts/              # AI prompt templates
    ├── development-methodology.txt  # Dev loop injected into every Claude step
    ├── dev-approach.txt             # Eval-only: tests methodology adherence
    ├── plan-research.txt            # Plan Pass 1: codebase research
    ├── plan-decompose.txt           # Plan Pass 2: step decomposition
    ├── plan-judge.txt               # Plan Pass 3: quality validation
    ├── plan-retry-judge.txt         # Plan retry after judge rejection
    ├── plan-retry-parse-error.txt   # Retry after JSON parse failure
    ├── plan-retry-schema-error.txt  # Retry after schema validation failure
    ├── plan-refine.txt              # Refine pass: apply instructions to existing YAML
    ├── plan-system-rules.txt        # Structural enforcement rules for plan generation
    ├── judge-evaluation.txt         # LLM-as-judge evaluation prompt
    ├── judge-retry-context.txt      # Retry context injected after judge FAIL
    └── self-healing-fix.txt         # Self-healing error analysis prompt

evals/                    # Eval test case definitions (run via npm run eval)
├── development-methodology.eval.yaml # development-methodology.txt (dev loop)
├── plan-decompose.eval.yaml          # plan-decompose.txt (Pass 2)
├── judge-evaluation.eval.yaml        # judge-evaluation.txt (llm_as_judge)
├── self-healing-fix.eval.yaml        # self-healing-fix.txt (self_healing)
├── plan-judge.eval.yaml              # plan-judge.txt (Pass 3)
└── fixtures/             # Reusable input fixtures for test cases
    ├── research-doc-simple.md
    ├── research-doc-complex.md
    ├── research-doc-repeat.md
    ├── research-doc-monorepo.md
    ├── research-doc-user-steps.md
    ├── self-healing-npm-start-output.txt
    ├── self-healing-npm-test-output.txt
    ├── self-healing-npm-build-output.txt
    ├── plan-judge-good-workflow.json
    ├── plan-judge-no-verification.json
    ├── plan-judge-hardcoded-paths.json
    ├── plan-judge-repeat-misuse.json
    ├── plan-judge-nested-steps-valid.json
    ├── plan-judge-nested-steps-atomicity-false-positive.json
    ├── judge-injection-output.txt
    └── goal-convert-legacy-api.txt
```

#### Prompts (`src/prompts/*.txt`)

Large text blocks passed to the Claude CLI for AI tasks. Loaded via `readFileSync` + `.replace()`. Support `{{VARIABLE}}` placeholder substitution.

**Prompts directory** (`src/prompts/`):

- Development methodology (`development-methodology.txt`) - Injected via `--append-system-prompt` into every Claude step
- Plan pipeline (`plan-research.txt`, `plan-decompose.txt`, `plan-judge.txt`, `plan-retry-judge.txt`, `plan-system-rules.txt`, `plan-retry-parse-error.txt`, `plan-retry-schema-error.txt`) - Used by `executant plan` three-pass pipeline (`plan.ts`)
- Plan refine (`plan-refine.txt`) - Used by `executant refine` subcommand (`refine.ts`)
- Judge evaluation (`judge-evaluation.txt`, `judge-retry-context.txt`) - Used by `llm_as_judge: true` steps (`runner.ts`)
- Self-healing analysis (`self-healing-fix.txt`) - Used by `self_healing: true` failures (`runner.ts`)

#### Adding New Prompts

1. Create `src/prompts/your-prompt-name.txt`
2. Add header comment block documenting purpose, usage, placeholders
3. Use `{{PLACEHOLDER}}` syntax for dynamic content
4. In TypeScript: `readFileSync(join(PROMPTS_DIR, 'your-prompt-name.txt'), 'utf8').replace('{{PLACEHOLDER}}', value)`

**Example prompt header:**

```bash
# ============================================================================
# YOUR PROMPT NAME
# ============================================================================
# Purpose: What this prompt does
# Used by: Which function/file uses it (with line numbers)
# Triggered when: Conditions that trigger this prompt
#
# Placeholders:
#   {{VARIABLE}} - Description of what gets substituted
# ============================================================================
```

### Key Behavior

- **Sequential execution**: Steps run in order, fail-fast on errors
- **Stateless**: Each step is independent, no state carried between steps
- **Streaming**: Real-time output via Ink TUI
- **Project detection**: Walks up directory tree to find `.claude/executant.local/tasks`
- **Remote workflows**: The workflow argument may be an `http(s)` URL (`src/lib/remote-workflow.ts`). GitHub blob/gist page URLs are rewritten to raw; private ones authenticate with `gh auth token` (sent only to GitHub raw hosts). A remote workflow runs with `process.cwd()` as its `workDir` and log root.
- **Interjection**: User presses `i` during execution to queue a correction. The message is prepended to the next Claude step's prompt as `[User correction from a previous step]`. The Claude CLI cannot receive mid-execution stdin input (it buffers all stdin until EOF before processing), so true mid-step injection is not possible — the correction always targets the next step.

### TypeScript Logging (`src/logger.ts`)

The `Logger` class subscribes to the runner's event stream via `withLogger()`:

- **Log files**: Written to `.claude/executant.local/logs/{timestamp}_{task-name}.log`
- **Disable**: Set `EXECUTANT_LOG=0` to skip all logging with zero overhead

### Telemetry (`src/telemetry.ts`)

The telemetry observer subscribes to the same event stream (via the same `withLogger()` tee — both implement the `Observer` interface exported from `logger.ts`):

- **Where data goes**: One OpenTelemetry trace per run — an `executant.run` root span, a child span per step (index/type/provider/model/cost attributes; `tool`/`healing`/`judge` span events), and iteration spans per forEach — plus five metrics (step duration/errors, cost by provider, healing attempts, judge verdicts), exported via OTLP/HTTP; every subprocess inherits a `TRACEPARENT` env var (via `src/lib/trace-context.ts`) so child tools join the same trace
- **Enable**: Set `OTEL_EXPORTER_OTLP_ENDPOINT` (optionally `OTEL_SERVICE_NAME`); when unset, `createTelemetry` returns `null` before importing anything — the OTel SDK is never loaded and behavior is byte-identical to a run without telemetry

### `context:` Field

The `context:` field on a prompt step lets you inject file contents into the prompt at runtime:

```yaml
vars:
  spec_file: /path/to/spec.md

steps:
  - name: implement
    prompt: Implement the feature described in the spec above.
    context:
      - spec_file # var name whose value is the file path
```

`context` is a list of var names (not file paths directly). Each named var's value must be a file path in the `vars` section. The file contents are prepended to the prompt as labelled code fences before Claude runs. Throws at load time if a var name is missing from `vars`.

## Eval System (Internal Dev Tooling)

The eval system tests and refines executant's own prompt templates (`src/prompts/*.txt`). It is not a user-facing feature — run via `npm run eval` during development.

### Eval YAML format (`evals/*.eval.yaml`)

```yaml
name: plan-decompose
prompt: src/prompts/plan-decompose.txt # template to test (relative to CWD)
placeholders:
  - DESCRIPTION # {{PLACEHOLDER}} names expected in template
  - RESEARCH_DOC
test_cases:
  - id: simple-feature
    vars:
      DESCRIPTION: "add rate limiting to all API endpoints"
      RESEARCH_DOC: fixtures/research-doc-simple.md # path → file content is read
    criteria:
      - "Output is valid JSON with a 'goal' field and a 'steps' array"
      - "No hardcoded file paths in any prompt or command field"
      - "Includes at least one script step running tests or lint"
```

### Running evals

```bash
# Score all test cases, no changes to prompt files
npm run eval -- evals/plan-decompose.eval.yaml

# Refine the prompt until all cases pass (modifies src/prompts/plan-decompose.txt)
npm run eval -- --refine evals/plan-decompose.eval.yaml

# Cap refinement iterations
npm run eval -- --refine --max-iter 3 evals/plan-decompose.eval.yaml
```

### How refinement works

1. Run all test cases → score each criterion via Claude judge
2. Collect failures (cases + failed criteria + reasons)
3. Call refinement agent → rewrites prompt template to fix failures
4. Save improved template to `src/prompts/<name>.txt`
5. Re-run eval to verify improvement
6. Repeat up to `--max-iter` times (default 5)

### Adding a new eval

1. Create `evals/your-prompt.eval.yaml` with test cases + criteria
2. Add fixtures to `evals/fixtures/` if needed (realistic inputs for the prompt)
3. Run `npm run eval evals/your-prompt.eval.yaml` to baseline

### Key files

- `src/eval/load.ts` — `loadEvalFile()`: Zod schema + fixture path resolution
- `src/eval/runner.ts` — `runPrompt()`: substitute vars, run Claude with no tools
- `src/eval/judge.ts` — `judgeOutput()`: score output against a single criterion
- `src/eval/refine.ts` — `refinePrompt()`: rewrite template based on failures

## Common Commands

### Generating Tasks

```bash
# Generate a task from simple description
executant plan "add logging to all endpoints"

# Generate complex multi-step task
executant plan "convert file.coffee to TypeScript with 80% test coverage"

# Generate from comprehensive prompt file
executant plan -f plan-prompt.txt

# Generate from multiline heredoc
executant plan <<EOF
Add user authentication with the following requirements:
- Email/password login form
- Session management with JWT tokens
- Protected routes middleware
- Password hashing with bcrypt
- Login/logout endpoints
EOF

# Generate from piped input
cat detailed-requirements.txt | executant plan

# Refine an existing task YAML with natural language instructions
executant refine tasks/todo/my-task.yaml "add a verification step at the end"

# Show help
executant plan --help
```

### Testing

```bash
npm test
```

### Dependencies

```bash
# claude CLI must be available
```

## Task File Patterns

### Claude Step (AI-Assisted)

- Use when task requires analysis, decision-making, or file operations
- Full access to Read, Edit, Write, Bash, Task, and all other tools
- API cost per step

### Script Step (Direct Execution)

- Use for deterministic commands: builds, tests, git operations
- No API cost, immediate execution
- Predictable, reliable behavior

### Quality Control Options

**Self-Healing (`self_healing: true`)**

- Applies to script steps only; defaults to `false` (opt-in per step)
- Automatically passes failures to Claude for analysis and fixing
- Claude diagnoses the issue, applies fixes, and re-runs the command
- Use for development workflows where auto-recovery is safe
- Example: Missing files, wrong paths, missing dependencies

**LLM as Judge (`llm_as_judge: true`)**

- Applies to both prompt and script steps
- After step completes, Claude evaluates the output quality
- If evaluation fails, step is retried with judge's feedback
- Retries up to 5 times maximum
- Use for critical steps requiring quality validation
- Example: Test coverage targets, code review thoroughness, documentation completeness

### Example Template Pattern

See `examples/` for workflow examples:

- Mixes script steps (npm commands) with Claude steps (code analysis)
- Uses `continue_on_error` for non-critical script failures
- Structures prompts with clear numbered instructions

## Plan Subcommand Implementation

### Overview

The `executant plan` subcommand generates YAML task files from natural language descriptions using a three-pass Claude pipeline.

**Location**: `src/plan.ts`

**Key components**:

1. `parsePlanArgs()` - Parses CLI arguments (supports `-f file`, `-q`/`--fast`, stdin, and direct string)
2. `streamPlan()` - Async generator running the pipeline, yielding `PlanEvent`s to the TUI
3. `isSimpleRequest()` - Heuristic that detects self-contained requests (repetition patterns, forEach) to skip research
4. `findProjectRoot()` - Walks up the directory tree to find `.claude/executant.local/tasks`

**Flags:**

- `-f, --file <path>` - Read prompt from specified file
- `-q, --fast` - Skip codebase research (auto-detected for simple tasks)
- `-h, --help` - Show help message with examples

### Generation Process

**Full path (3 passes)** — when codebase exploration is needed:

1. Parse arguments (string, `-f file`, or stdin)
2. Find project root via `findProjectRoot()`
3. Generate timestamped filename
4. **Pass 1 — Research** (`plan-research.txt`): Claude explores the codebase with Read/Glob/Grep, produces a markdown plan document
5. **Pass 2 — Decompose** (`plan-decompose.txt`): Claude converts the plan document to a structured JSON workflow (retries up to 3×)
6. **Pass 3 — Validate** (`plan-judge.txt`): LLM-as-judge evaluates verification steps, atomicity, goal coverage; rejects drive Pass 2 retries
7. Validate JSON output via Zod schema, convert to YAML, write to `tasks/todo/`

**Fast path (2 passes)** — when `--fast` is set or `isSimpleRequest()` returns true:

- Skips Pass 1 entirely; passes a "no research" placeholder to Pass 2
- `isSimpleRequest()` detects: repetition (`N times`, `N iterations`, `N passes`) and `for each` patterns
- Reduces plan generation from ~20 min to ~30 sec for self-contained requests

### Error Handling

- **No description**: Shows usage and exits
- **Outside project**: Shows error and exits
- **Claude API failure**: Shows error message
- **Invalid JSON/YAML**: Retries up to 3 times with corrective feedback

## Important Implementation Details

### Permission Model

- Executant uses `--permission-mode bypassPermissions`
- Commands matching patterns in `.claude/settings.local.json` are auto-approved

### Error Handling

- Script steps: Exit on error unless `continue_on_error: true`
- Claude steps: Fail if claude CLI returns non-zero
- Task files remain in todo/ on failure for retry

## Testing

```bash
npm test
```

TypeScript test suite: `src/tests/` — covers self-healing, forEach, output capture, context injection, plan generation, refine subcommand, update subcommand, UI reducer, structured events, telemetry, trace-context propagation, and more.

### Test Requirements for Contributors

- New features MUST have unit tests
- Bug fixes MUST have regression tests
- Ensure all tests pass before committing

## Installation

```bash
./install.sh
```

Creates `~/bin/executant` symlink. Requires `~/bin` in PATH.

## Project Setup Pattern

```bash
# Create task directories
mkdir -p .claude/executant.local/tasks/{todo,done}

# Configure permissions (optional)
cat > .claude/settings.local.json << 'EOF'
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "Read(/src/**)",
      "Edit(/src/**)",
      "Write(/src/**)"
    ]
  }
}
EOF
```
