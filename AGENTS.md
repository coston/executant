# CLAUDE.md

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

## Core Architecture

### Main Components

1. **Task YAML files** - Workflow definitions
   - `goal`: High-level task description
   - `steps`: Array of step objects with `name` and either `prompt`, `command`, or `message`
   - `vars`: Optional map of key/value pairs substituted as `{{var_name}}` in prompts and commands
   - `self_improve: true` - Optional, run retrospective analysis after completion (saves improved YAML to `tasks/backlog/`)
   - `type: prompt` (default) - Execute with Claude Code (all tools available)
   - `type: script` - Execute directly with bash (no API cost)
   - `type: log` - Emit a plain text progress marker (no API cost, no command)
   - `continue_on_error: true` - Optional, allows script steps to fail without stopping
   - `self_healing: true` - Optional (defaults to `false`; opt-in per step), automatically passes script failures to Claude for fixing
   - `llm_as_judge: true` - Optional, evaluates step quality and retries up to 5 times if needed
   - `allowed_tools` - Optional list restricting which Claude tools are available for a prompt step
   - `context` - Optional list of var names whose values are file paths; file contents are prepended to the prompt at runtime
   - `forEach` - Optional inline array or shell command (newline-split stdout); runs the inner step once per item with `{{item}}` substituted
   - `repeat: N` - Runs the step N times sequentially (compiles to a ForEachTask at load time); mutually exclusive with `forEach`; `{{item}}` is the 1-based iteration number

2. **TypeScript implementation** (`src/`)
   - `src/index.ts` - Entry point: CLI parsing, Ink TUI rendering, CI mode (NDJSON), `plan`/`update` subcommands
   - `src/load-workflow.ts` - YAML → typed `Workflow`
   - `src/runner.ts` - Pure async generator yielding `Event`s; self-healing, LLM-as-judge, forEach, context injection
   - `src/logger.ts` - Subscribes to event stream; writes `.log` files and highlight markdown files to `.claude/executant.local/logs/`
   - `src/retrospective.ts` - Self-improvement: reads highlight files, calls Claude, saves improved YAML + changelog to `tasks/backlog/`
   - `src/types.ts` - All shared types: `Task`, `Event`, `Workflow`, `RawWorkflow`/`RawStep` (YAML schema)

### Module Architecture

#### Directory Structure

```
src/
├── index.ts              # Entry point (CLI, TUI, CI mode, plan/update subcommands)
├── load-workflow.ts      # YAML → typed Workflow
├── runner.ts             # Workflow execution (self-healing, judge, forEach, context)
├── logger.ts             # Execution logger (log files + highlight files)
├── retrospective.ts      # Self-improvement retrospective
├── types.ts              # All shared types
├── tasks/
│   ├── claude.ts         # Claude CLI child process runner
│   ├── command.ts        # Bash command runner
│   └── stream.ts         # Shared stream utilities (AsyncQueue, mergeStreamsToLines)
├── ui/                   # Ink TUI components
├── prompts/              # AI prompt templates
│   ├── plan-research.txt        # Plan Pass 1: codebase research
│   ├── plan-decompose.txt       # Plan Pass 2: step decomposition
│   ├── plan-judge.txt           # Plan Pass 3: quality validation
│   ├── plan-retry-judge.txt     # Plan retry after judge rejection
│   ├── judge-evaluation.txt     # LLM-as-judge evaluation prompt
│   ├── self-healing-fix.txt     # Self-healing error analysis prompt
│   └── retrospective-analysis.txt  # Self-improvement analysis prompt
├── eval/                 # Internal eval dev tooling (npm run eval)
│   ├── index.ts          # CLI entry: arg parsing, orchestration
│   ├── types.ts          # EvalFile, TestCase, CriterionResult, EvalRun
│   ├── load.ts           # YAML → EvalFile (Zod validation, fixture resolution)
│   ├── runner.ts         # runPrompt(): substitute vars, run Claude, return text
│   ├── judge.ts          # judgeOutput(): score output against a criterion
│   ├── refine.ts         # refinePrompt(): rewrite template to fix failures
│   ├── report.ts         # Terminal output: pass/fail table with reasons
│   └── prompts/          # Eval-specific prompt templates
│       ├── criterion-judge.txt   # Judge: output × criterion → {pass, reason}
│       └── prompt-refiner.txt    # Refiner: template × failures → improved template
└── plan.ts               # `executant plan` subcommand

evals/                    # Eval test case definitions (run via npm run eval)
├── plan-decompose.eval.yaml
└── fixtures/             # Reusable input fixtures for test cases
    ├── research-doc-simple.md
    ├── research-doc-complex.md
    └── research-doc-repeat.md
```

#### Prompts (`src/prompts/*.txt`)

Large text blocks passed to the Claude CLI for AI tasks. Loaded via `readFileSync` + `.replace()`. Support `{{VARIABLE}}` placeholder substitution.

**Prompts directory** (`src/prompts/`):
- Plan pipeline prompts (`plan-research.txt`, `plan-decompose.txt`, `plan-judge.txt`, `plan-retry-judge.txt`) - Used by `executant plan` three-pass pipeline (`plan.ts`)
- Judge evaluation criteria (`judge-evaluation.txt`) - Used by `llm_as_judge: true` steps (`runner.ts`)
- Self-healing analysis (`self-healing-fix.txt`) - Used by `self_healing: true` failures (`runner.ts`)
- Retrospective analysis (`retrospective-analysis.txt`) - Used by `self_improve: true` workflows (`retrospective.ts`)

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
- **Auto-move**: Completed tasks auto-move to done/ with timestamp
- **Project detection**: Walks up directory tree to find `.claude/executant.local/tasks`

### TypeScript Logging (`src/logger.ts`)

The `Logger` class subscribes to the runner's event stream via `withLogger()`:

- **Log files**: Written to `.claude/executant.local/logs/{timestamp}_{task-name}.log`
- **Highlights**: Written to `.claude/executant.local/logs/highlights/` — one file per judge verdict, self-healing activation, or complex tool sequence (3+ tools in one step)
- **Index**: `highlights/README.md` is updated after each run
- **Disable**: Set `EXECUTANT_LOG=0` to skip all logging with zero overhead
- **Used by**: `src/retrospective.ts` reads highlight files to drive self-improvement analysis

### `context:` Field

The `context:` field on a prompt step lets you inject file contents into the prompt at runtime:

```yaml
vars:
  spec_file: /path/to/spec.md

steps:
  - name: implement
    prompt: Implement the feature described in the spec above.
    context:
      - spec_file   # var name whose value is the file path
```

`context` is a list of var names (not file paths directly). Each named var's value must be a file path in the `vars` section. The file contents are prepended to the prompt as labelled code fences before Claude runs. Throws at load time if a var name is missing from `vars`.

## Eval System (Internal Dev Tooling)

The eval system tests and refines executant's own prompt templates (`src/prompts/*.txt`). It is not a user-facing feature — run via `npm run eval` during development.

### Eval YAML format (`evals/*.eval.yaml`)

```yaml
name: plan-decompose
prompt: src/prompts/plan-decompose.txt   # template to test (relative to CWD)
placeholders:
  - DESCRIPTION                          # {{PLACEHOLDER}} names expected in template
  - RESEARCH_DOC
test_cases:
  - id: simple-feature
    vars:
      DESCRIPTION: "add rate limiting to all API endpoints"
      RESEARCH_DOC: fixtures/research-doc-simple.md  # path → file content is read
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

TypeScript test suite: `src/tests/` (7 files, ~280 test cases covering self-healing, forEach, output capture, context injection, plan generation, update subcommand, and UI reducer).

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

## Self-Improvement Feature

The `self_improve: true` option enables automatic retrospective analysis after task completion. When enabled, Executant analyzes execution highlights (judge failures, self-healing events, complex tool sequences) and generates an improved version of the task with a detailed changelog.

### How It Works

1. **Execute task normally** - All steps run as usual
2. **Analyze highlights** - After completion, Claude reviews:
   - Judge verdict highlights (`*_judge_FAIL.md`, `*_judge_PASS.md`)
   - Self-healing highlights (`*_self_healing.md`)
   - Complex tool sequences (`*_complex_sequence.md`)
3. **Generate improvements** - Claude identifies problems and creates:
   - Improved task YAML with fixes (saved to `tasks/backlog/`)
   - Detailed changelog explaining what changed and why
4. **Non-blocking** - If retrospective fails, task still completes successfully

### Enabling Self-Improvement

Add `self_improve: true` to your task YAML:

```yaml
goal: "Convert CoffeeScript to TypeScript with validation"
self_improve: true  # Enable automatic improvement

steps:
  - name: "convert"
    type: script
    command: coffee2ts convert app.coffee
    self_healing: true

  - name: "validate"
    llm_as_judge: true
    prompt: |
      Validate the TypeScript conversion:
      1. Check types are correct
      2. Verify functionality matches
      3. Run tests
```

### What Gets Analyzed

**Judge Failures** - Indicate unclear prompts or missing success criteria
- Fix: Add numbered sub-steps to prompts
- Fix: Define explicit success criteria
- Fix: Break large steps into smaller ones

**Self-Healing Events** - Indicate brittle scripts or environment issues
- Fix: Add prerequisite steps (install deps, create directories)
- Fix: Use absolute paths instead of relative
- Fix: Add checks before operations

**Complex Tool Sequences** - Indicate vague instructions requiring exploration
- Fix: Split research and implementation into separate steps
- Fix: Provide specific file paths in prompts
- Fix: Add discovery step before action step

### Output Location

Improved tasks are saved to `tasks/backlog/` directory:

```
.claude/executant.local/tasks/
├── todo/              # Tasks to execute
├── done/              # Completed tasks
└── backlog/           # Improved versions
    ├── 20260120-143022-my-task-improved.yaml
    └── 20260120-143022-my-task-changelog.md
```

### Using Improved Tasks

```bash
# Review the improvement
cat tasks/backlog/20260120-143022-my-task-changelog.md

# Compare original vs improved
diff tasks/done/20260120-143022-my-task.yaml \
     tasks/backlog/20260120-143022-my-task-improved.yaml

# Use the improved version
mv tasks/backlog/20260120-143022-my-task-improved.yaml \
   tasks/todo/my-task-v2.yaml

executant
```

### Key Behaviors

1. **Goal Preservation** - Improved tasks keep the original goal (proven workflow)
2. **Evidence-Based** - Only fixes problems shown in highlights, no unnecessary changes
3. **Non-Blocking** - Retrospective failures don't prevent task completion
4. **Backlog Isolation** - Improved tasks saved separately for review before use
5. **Recursive** - `self_improve: true` preserved for continuous refinement

**TypeScript implementation:** `src/retrospective.ts`. Called from `src/index.ts` after `workflow:complete`. Non-blocking — all errors are caught; the workflow still completes successfully.

### Error Handling

All retrospective failures are non-blocking:
- Missing highlights → Skip with message (task succeeded without issues)
- No highlights directory → Skip (logging may be disabled)
- Claude API failure → Log warning, task still completes
- Invalid YAML generated → Save raw output for debug, task still completes
