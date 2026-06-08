<img width="1774" height="887" alt="e58fdd14-77a1-4207-99c2-fb8603e3f625" src="https://github.com/user-attachments/assets/8d57a6ee-0fd3-43c9-bdff-1538fe931337" />

# Executant

Harness for YAML-defined workflows that enables stepping through Claude sessions and bash commands.

## Advisory
Built for personal use by Coston. Public for sharing the approach. Use at your own risk. 

## Install

```bash
npm install -g executant
```

Requires [Node.js](https://nodejs.org) and at least one coding-agent CLI:
- [Claude Code CLI](https://claude.ai/code) (default)
- [OpenCode CLI](https://opencode.ai/docs/cli) (optional alternative)

## Quick Start

```yaml
# workflow.yaml
goal: "Review and test my changes"

steps:
  - name: test
    type: script
    command: npm test

  - name: review
    prompt: |
      Review the changes in git diff and summarise any concerns.
```

```bash
executant workflow.yaml
```

## How It Works

A workflow is a YAML file with a `goal` and a list of `steps`. Each step is either a **prompt** (Claude runs it with full tool access), a **script** (bash runs it directly), a **log** (progress marker), or a **forEach** (iterates over a list). Steps run in order; the TUI shows live output and elapsed time for each.

## Generating Workflows

```bash
executant plan "convert all CoffeeScript files to TypeScript and run tests"
```

Generates a workflow YAML in your project's task directory using a three-pass Claude pipeline (research → decompose → validate). Also accepts `-f file` or stdin.

For self-contained requests (repetition patterns, forEach loops, or anything that doesn't need codebase exploration), the research pass is skipped automatically — going straight to decompose + validate. Use `-q` / `--fast` to force-skip research for any request:

```bash
executant plan -q "repeat the following prompt 20 times: review src/ for issues"
executant plan --fast "for each file in the list, run the linter"
```

## Context & Variables

Use `vars` to define shared values substituted as `{{var_name}}` in any prompt or command. Pair with `context` to inject file contents directly into a prompt at runtime, and `output` to pipe a script step's stdout into a file for downstream steps to read.

```yaml
vars:
  spec: docs/spec.md
  report: /tmp/report.txt

steps:
  - name: implement
    context: [spec]           # prepends docs/spec.md contents to the prompt
    prompt: Implement the feature described in the spec above.

  - name: audit
    type: script
    command: npm run audit
    output: report            # captures stdout to /tmp/report.txt

  - name: summarise
    prompt: Summarise the audit findings in {{report}}.
```

Use `forEach` to repeat a step over a list or shell command output — `{{item}}` is substituted per iteration:

```yaml
steps:
  - name: lint {{item}}
    forEach: "git diff --name-only HEAD~1"   # or an inline list: [a.ts, b.ts]
    type: script
    command: npx eslint src/{{item}}
```

Use `steps:` inside a `forEach` or `repeat` to run **multiple child steps per iteration**:

```yaml
steps:
  - name: verify each package
    forEach: [packages/api, packages/web, packages/shared]
    steps:
      - name: lint {{item}}
        type: script
        command: npm run lint --workspace={{item}}
      - name: test {{item}}
        type: script
        command: npm test --workspace={{item}}
      - name: build {{item}}
        type: script
        command: npm run build --workspace={{item}}
```

Use `repeat: N` as shorthand when there is no meaningful list — just a count. `{{item}}` is the 1-based iteration number:

```yaml
steps:
  - name: iterative audit
    repeat: 5
    prompt: |
      This is pass {{item}} of 5. Review src/runner.ts for untested edge cases.
```

## Variables at Runtime

Pass `--var KEY=VALUE` on the command line to override or supply workflow vars without editing the YAML:

```bash
executant --var env=staging --var region=eu-west-1 deploy.yaml
```

CLI vars override any same-named vars in the workflow's `vars:` section. Multiple `--var` flags are accepted.

## Provider & Model Selection

Executant supports multiple coding-agent CLI backends. Claude is the default; OpenCode is a first-class alternative that supports a wide range of open models.

### Global defaults via env vars

```bash
# Use OpenCode for all prompt steps
export EXECUTANT_PROVIDER=opencode
export EXECUTANT_MODEL=opencode-go/kimi-k2.6
export EXECUTANT_AGENT=build

executant workflow.yaml
```

### Per-step in YAML

```yaml
goal: "Review and implement changes"

steps:
  - name: implement
    provider: opencode
    model: opencode-go/kimi-k2.6
    agent: build
    prompt: |
      Implement the requested change and run tests.

  - name: review
    provider: claude
    model: sonnet
    prompt: |
      Review the git diff and summarise risks.
```

### Env vars reference

| Variable | Description | Default |
|---|---|---|
| `EXECUTANT_PROVIDER` | Agent backend: `claude` or `opencode` | `claude` |
| `EXECUTANT_MODEL` | Model name. Claude: `sonnet`/`opus`. OpenCode: `opencode-go/kimi-k2.6` etc. | per-provider default |
| `EXECUTANT_AGENT` | OpenCode `--agent` name (ignored by Claude) | — |

Step-level `provider`, `model`, and `agent` fields take priority over env vars.

## Quality Controls

- **`llm_as_judge: true`** — after a step completes, Claude evaluates the output; retries with feedback on FAIL, up to 5×
- **`self_healing: true`** — on script failure, Claude diagnoses and repairs the command, then re-runs it, up to 5×
- **`timeout_seconds: N`** — kill the step after N seconds and fail with exit code 3. Works for both script and prompt steps.

```yaml
steps:
  - name: install
    command: npm ci
    timeout_seconds: 120   # fail if install takes longer than 2 min

  - name: implement
    prompt: Implement the feature described above.
    timeout_seconds: 1800  # 30 min ceiling for the Claude step
```

## Cancellation

Write a `.executant-cancel` file in the **same directory as the workflow YAML** to stop the workflow cleanly **between steps**:

```bash
executant long-workflow.yaml &
touch .executant-cancel   # workflow stops at the next step boundary; exits 4
```

The file is deleted automatically. This is a cooperative, process-safe alternative to SIGTERM — no mid-step git state corruption. The cancel file is always resolved relative to the workflow file, so the location is predictable regardless of which directory you invoked executant from.

## Interjection

While a workflow is running, press **`i`** to open a text input at the bottom of the TUI. Type a correction and press **Enter** to send it; **Esc** cancels.

The message is queued and prepended to the **next Claude step's prompt** as `[User correction from a previous step]`. Claude sees your note before it starts and incorporates it into its work. If you interject while a script step is running, the correction waits for the next Claude step in the workflow.

```
press i  →  ▷ don't delete that file, use git revert▌  esc to cancel
```

**What it's good for:** steering the next Claude step while watching the current one run — leaving a note for the step that's about to start.

**What it can't do:** interrupt a Claude step mid-execution. The Claude CLI processes each invocation as a complete unit; there's no mechanism to inject a message partway through. To abort a runaway step immediately, press `q`.

## Examples

| File | Demonstrates |
|------|-------------|
| `hello-world.yaml` | Simple prompt steps |
| `mixed-workflow.yaml` | Script + prompt steps together |
| `foreach-demo.yaml` | Inline lists and shell command iteration |
| `nested-steps-demo.yaml` | Multiple child steps per forEach / repeat iteration |
| `vars-demo.yaml` | Variable substitution |
| `judge-demo.yaml` | LLM-as-judge retry loop |
| `logging-demo.yaml` | Log steps, self-healing, judge |
| `git-status-summary.yaml` | Real-world git workflow |
| `repeat-demo.yaml` | Running a step N times with `repeat` |
| `file-demo.yaml` | File operations |
| `from-step-test.yaml` | Using `--from-step` to resume mid-workflow |

See the [`examples/`](examples/) directory.

## CLI

```bash
executant plan "description"                    # generate a workflow YAML (auto-detects fast path)
executant plan -q "description"                 # skip research pass (fast path)
executant refine workflow.yaml "instructions"   # refine an existing workflow YAML
executant workflow.yaml                         # run a workflow
executant --ci workflow.yaml                    # headless, NDJSON to stdout
executant --step <name|n> wf.yaml              # run one step by name or index
executant --from-step <n> wf.yaml              # resume from step n
executant --var KEY=VALUE wf.yaml              # override a workflow var at runtime
executant update                                # upgrade to latest version
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All steps completed successfully |
| `1` | A step failed at runtime |
| `2` | YAML or variable validation error |
| `3` | A step timed out (`timeout_seconds` exceeded) |
| `4` | Cancelled via `.executant-cancel` file |

## Development

```bash
npm test                                          # run tests
npm run eval evals/plan-decompose.eval.yaml       # score prompt templates
npm run eval -- --refine evals/plan-decompose.eval.yaml  # refine until all cases pass
```

The eval system tests and iteratively refines the prompt templates in `src/prompts/`. Eval definitions live in `evals/*.eval.yaml`; see `AGENTS.md` for the full format.

### Multi-model comparison

Run the same eval against multiple providers and export the results for analysis:

```bash
# Compare Claude vs OpenCode on a single eval
npm run eval -- \
  --models claude/sonnet,opencode/opencode-go/kimi-k2.6 \
  --output-json results/comparison.json \
  --output-csv results/comparison.csv \
  evals/judge-evaluation.eval.yaml

# Run all evals and produce a white-paper CSV
npm run eval -- \
  --models claude/sonnet,opencode/opencode-go/kimi-k2.6 \
  --output-csv results/full-comparison.csv \
  evals/plan-decompose.eval.yaml
```

The `--output-csv` file is denormalized (one row per criterion judgment per model) — ready for pivot tables and charts. See `docs/eval-comparison.md` for column definitions and interpretation guidance.
