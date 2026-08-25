<img width="1774" height="887" alt="e58fdd14-77a1-4207-99c2-fb8603e3f625" src="https://github.com/user-attachments/assets/8d57a6ee-0fd3-43c9-bdff-1538fe931337" />

# Executant

Harness for YAML-defined workflows that enables stepping through Claude sessions and bash commands.

## Advisory

Built for personal use by Coston. Public for sharing the approach. Use at your own risk.

## Install

```bash
npm install -g executant
```

**Requirements:**

- [Node.js](https://nodejs.org) 18+
- At least one coding-agent CLI on `PATH`:
  - [Claude Code](https://claude.ai/code) — `npm install -g @anthropic-ai/claude-code` (default)
  - [OpenCode](https://opencode.ai/docs/cli) — `npm install -g opencode-ai` (local/alternative models)

That's it. Executant has no other system dependencies. It runs on macOS and Linux.

For local LLM inference via llama.cpp (Apple Silicon Metal GPU), see [docs/local-models.md](docs/local-models.md).

Run `npm run setup` to verify all dependencies are installed and configured.

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

## Running a Remote Workflow

The workflow argument can be an `http(s)` URL instead of a local path, so a workflow can be shared from a repo or a gist without cloning it:

```bash
executant https://github.com/owner/repo/blob/main/tasks/deploy.yaml
executant https://gist.github.com/user/abc123
```

- GitHub blob and gist **page** URLs are rewritten to their raw equivalents, so you can paste the URL straight from the browser. Raw URLs and non-GitHub URLs are fetched as-is.
- **Private** repos and gists authenticate with the token from your existing `gh auth login`. The token is only ever sent to `raw.githubusercontent.com` and `gist.githubusercontent.com`.
- A remote workflow runs in **your current directory** — script steps use it as their working directory, and logs are written to its `.claude/executant.local/logs/`.
- Because there is no local workflow directory, any file paths a remote workflow needs should come from `vars` or `--var KEY=VALUE`.

## Nested Workflows

A step can run another workflow — local file or URL — as a self-contained sub-run:

```yaml
steps:
  - name: release
    workflow: ./deploy.yaml
    vars:
      region: us-east-1 # passed to the child; overrides its own vars
```

The child's steps run in order and nest under this one step in the parent's view — `release` stays a single top-level row, with each child step shown beneath it as an indented sub-row (`✔ [1/3] build image`) and a `(2/3)` counter on the parent — and a failure inside the child fails `release` the same way any other step failure would (`continue_on_error` on the workflow step works as usual).

A child module's required vars — the entries in its `vars:` block declared with no value (see [Variables at Runtime](#variables-at-runtime)) — are its interface: the vars it requires from whoever runs it. Because every reference is resolved before any step runs, a parent that forgets to pass one of the child's required vars fails fast at load time rather than deep into the run.

Every referenced workflow, however deep the chain and however many local files or URLs it crosses, is fetched and validated **before execution starts** — a bad reference anywhere fails fast at load time, before any step runs or any API cost is spent. Relative references resolve against wherever the *referencing* workflow itself lives:

- A local workflow's relative reference resolves against its own directory.
- A remote workflow's relative reference resolves against its own URL — never the local filesystem, even for a reference that looks like an absolute local path. This means a workflow fetched from GitHub can reference sibling files in the same repo by relative path and it works the same way whether you run it locally or straight from a URL.

Point the `workflow:` reference straight at the module file — that keeps the wiring legible: you can see exactly what each step runs by reading the pipeline. When you need a different module, prefer a separate pipeline file that names it directly over parameterizing one file.

For the cases where the *invoker* — not the pipeline author — must choose the module at run time (a CI job parameterized by `--var`, a matrix that would otherwise need many near-identical files), the `workflow:` reference is substituted like any other field, so it can be late-bound to a var:

```yaml
vars:
  deployer: ./modules/deploy-staging.yaml # default; override with --var deployer=...
steps:
  - name: deploy
    workflow: "{{deployer}}"
    vars:
      region: "{{region}}"
```

An unknown placeholder in the reference fails fast at load time, same as any other var. Use this only when the choice genuinely happens at invocation; otherwise a direct reference is clearer.

Not supported: `workflow:` steps inside `forEach`/`repeat` (a nested workflow is resolved once, at load time, before any iteration runs — there's no way to thread a per-iteration value into it), and `--from-step`/`--step`/`--to-step` targeting a nested workflow's own steps (resume from an earlier step instead).

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

Use `vars` to define shared values substituted as `{{var_name}}` in any prompt or command. Pair with `context` to inject file contents directly into a prompt at runtime, and `output` to have a step produce a file for downstream steps to read. What `output` means depends on the step: a script step's stdout is captured to the file; a prompt step's file is expected to already exist by the time the step finishes (from its own Write/Edit tool calls) — the step fails if it doesn't, so you don't need a separate `test -f ...` script step just to catch a step that silently skipped writing its file.

```yaml
vars:
  spec: docs/spec.md
  report: /tmp/report.txt
  diagnostic: /tmp/diagnostic.md

steps:
  - name: implement
    context: [spec] # prepends docs/spec.md contents to the prompt
    prompt: Implement the feature described in the spec above.

  - name: audit
    type: script
    command: npm run audit
    output: report # captures stdout to /tmp/report.txt

  - name: diagnose
    prompt: Diagnose current-vs-required behavior and write {{diagnostic}}.
    output: diagnostic # fails the step if this file doesn't exist afterward

  - name: summarise
    prompt: Summarise the audit findings in {{report}}.
```

Use `forEach` to repeat a step over a list or shell command output — `{{item}}` is substituted per iteration:

```yaml
steps:
  - name: lint {{item}}
    forEach: "git diff --name-only HEAD~1" # or an inline list: [a.ts, b.ts]
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

By default `forEach`/`repeat` iterations run one at a time. Add `concurrency: N` when iterations are genuinely independent and the per-item work is slow enough that wall-clock time matters — it runs up to N at once, in batches (batch two starts only once every item in batch one has finished):

```yaml
steps:
  - name: verify each package
    forEach: [packages/api, packages/web, packages/shared]
    concurrency: 3
    steps:
      - name: lint {{item}}
        type: script
        command: npm run lint --workspace={{item}}
      - name: test {{item}}
        type: script
        command: npm test --workspace={{item}}
```

`concurrency` buys speed, not lower token cost — each iteration still pays its own full context, so scope what each iteration reads independently of whether it runs concurrently. Don't reach for it when iterations share a mutable resource (the same working tree, a scratch file one iteration writes and another reads) or when a later step needs a view across every item to decide anything — those need coordination or a final aggregation step, not concurrency inside the loop. There's also no `--from-step` support into a specific iteration of a concurrent step — a resume target inside one re-runs every iteration from the start instead (with a warning), so design each iteration to detect and skip its own already-done work rather than relying on resume.

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

### Required vars

There is one convention for both defaults and required values: the `vars:` block. A var **with** a value is a default the workflow supplies for itself, overridable from outside. A var declared **with no value** (an empty `name:`) is **required** — it has no default and must come from a `--var` or, when the workflow runs as a nested `workflow:` step, the parent step's `vars:`:

```yaml
goal: "Deploy a service to a region"

vars:
  env: staging # has a default — overridable
  region: # required — no default; must be supplied from outside

steps:
  - name: deploy
    type: script
    command: echo "Deploying {{env}} to {{region}}"
```

This is enforced at load time, before any step runs:

- A required var (declared with no value) that nothing provides is an error: `missing required var "region" — declared with no default, so provide via --var REGION=VALUE or a parent workflow step's vars:`.
- A `--var` (or parent `vars:`) that matches no declared `vars:` slot is an error: `was given "region" but does not declare it — add "region" to vars: (with a value for a default, or no value to require it)`. You cannot pass a var a workflow doesn't declare.

This makes a workflow explicit about what it needs from outside: its required (valueless) vars are its interface signature, so a parent that under-provides a nested module's required vars fails fast rather than substituting an empty value.

## Provider & Model Selection

Executant supports multiple coding-agent CLI backends. Claude is the default; OpenCode is a first-class alternative that supports a wide range of open models.

### Global defaults via env vars

```bash
# Use OpenCode for all prompt steps
export EXECUTANT_PROVIDER=opencode
export EXECUTANT_MODEL=llama-qwen7b/qwen2.5-coder-7b
export EXECUTANT_AGENT=build

executant workflow.yaml
```

### Per-step in YAML

```yaml
goal: "Review and implement changes"

steps:
  - name: implement
    provider: opencode
    model: llama-qwen7b/qwen2.5-coder-7b
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

| Variable                      | Description                                                                                         | Default               |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | --------------------- |
| `EXECUTANT_PROVIDER`          | Agent backend: `claude` or `opencode`                                                               | `claude`              |
| `EXECUTANT_MODEL`             | Model name. Claude: `sonnet`/`opus`. OpenCode: `llama-qwen7b/qwen2.5-coder-7b` etc.                 | per-provider default  |
| `EXECUTANT_AGENT`             | OpenCode `--agent` name (ignored by Claude)                                                         | —                     |
| `EXECUTANT_STATUSLINE`        | Set to `0` to hide the [context gauge](#statusline) (the test suite sets this)                      | enabled               |
| `EXECUTANT_REPORT_SUGGESTION` | Set to `0` to skip the [run report](#run-report)'s efficiency-suggestion API call                   | enabled               |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enables [observability](#observability): exports traces + metrics to this OTLP/HTTP collector       | unset (telemetry off) |
| `OTEL_SERVICE_NAME`           | `service.name` on exported telemetry                                                                | `executant`           |
| `TRACEPARENT`                 | Set _by_ executant on every subprocess when telemetry is on — W3C trace context of the current step | —                     |

Step-level `provider`, `model`, and `agent` fields take priority over env vars.

## Quality Controls

- **`llm_as_judge: true`** — after a step completes, Claude evaluates the output; retries with feedback on FAIL, up to 5×
- **`self_healing: true`** — on script failure, Claude diagnoses and repairs the command, then re-runs it, up to 5×
- **`timeout_seconds: N`** — kill the step after N seconds and fail with exit code 3. Works for both script and prompt steps.
- **`allowed_tools`** — restrict which tools a prompt step can use:
  - Omit entirely → all tools available (default)
  - `allowed_tools: []` → text-only mode, no tools
  - `allowed_tools: [Bash, Read, Write]` → only those tools; names are case-insensitive

```yaml
steps:
  - name: analyse
    prompt: Review the architecture and list concerns.
    allowed_tools: [Read, Glob, Grep] # read-only: no edits or bash

  - name: summarise
    prompt: Write a one-paragraph summary.
    allowed_tools: [] # no tools — pure text generation
```

```yaml
steps:
  - name: install
    command: npm ci
    timeout_seconds: 120 # fail if install takes longer than 2 min

  - name: implement
    prompt: Implement the feature described above.
    timeout_seconds: 1800 # 30 min ceiling for the Claude step
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

## Output pane: scroll and resize

The step list is always shown in full — it's the primary view, and it's never trimmed to make room. The live output pane below it does all the resizing instead, shrinking to whatever space is left under the full list.

- **Scroll**: `↑`/`k` and `↓`/`j` move one line at a time, `PageUp`/`PageDown` move a page. Scrolling up pauses live-tailing and shows `— scrolled up N lines · ↓ to follow —`; scrolling back down to the bottom resumes following the active step's output. Scroll position resets to the live tail whenever a new step starts.
- **Resize**: `[` shrinks the pane, `]` grows it — one line at a time. Where the terminal supports it, you can also grab the pane's bottom border with the mouse and drag. Either way, the first resize freezes the pane at that height for the rest of the run; it no longer auto-grows or auto-shrinks as later steps' step lists grow, though it's still clamped down if a shrinking terminal window can't fit it.

Mouse dragging is best-effort — Ink (the TUI library executant is built on) has no built-in support for mouse input or on-screen element position, so it's reconstructed from raw terminal escape sequences and may not work in every terminal/multiplexer combination. `[`/`]` always work.

## Failure retrospectives

When a step fails and stops the run, executant writes a post-mortem before it exits and shows it in the TUI:

```
╭──────────────────────────────────────────────────────────╮
│ retrospective — check-dist                               │
│                                                          │
│ The step failed because dist/ was never created.         │
│                                                          │
│ root cause                                               │
│ No build step runs before the check.                     │
│                                                          │
│ evidence                                                 │
│   · ls: dist: No such file or directory                  │
│                                                          │
│ task file                                                │
│   · check-dist: assumes a build that never runs          │
│     → add a build step before it                         │
│                                                          │
│ ❯ [u] Update the task file with these changes            │
│   [d] Dismiss                                            │
│   [o] show the step output                               │
╰──────────────────────────────────────────────────────────╯
```

Press **`o`** to swap the analysis for the failing step's raw output and back — the post-mortem is a reading of that output, and this is how you check it.

### Judge and self-healing failures

When a step dies to `llm_as_judge`, the error says only "failed judge evaluation after 5 attempts" — the reasons live in the per-attempt feedback. Every verdict is handed to the analysis, which is asked to distinguish the cases that need different fixes:

- the work was genuinely incomplete — what was missing
- the feedback changed every attempt — the step is too large or the success condition is subjective; split it or define done
- the same feedback repeated and nothing moved — the prompt can't satisfy the criterion as written (unattainable, contradictory, or outside its `allowed_tools`)
- the judge was wrong — the criterion is misconceived, and the workflow needs no change

It recommends more retries only when the attempts were visibly converging; repeating a step that never moved just spends five times the money. Self-healing exhaustion gets the same treatment across its fix attempts. Failures inside a `forEach` name the iteration and item that broke, not just the container.

### What it looks at

The analysis reads the error, the failing step's output, its judge/self-healing history, **and the workflow file itself** — so it can flag problems only visible at the file level: a `{{var}}` that resolved to nothing, a `repeat` count too low to converge, a fragile step that should carry `self_healing: true`, an `allowed_tools` list too narrow for the prompt, a long step with no `timeout_seconds`.

Choose **`u`** and executant runs `refine` on the task file with the suggested changes, showing the diff before it writes. Choose **`d`** to dismiss. The update action is offered only when changing the workflow would actually have helped — when the fault is a genuine failing test or a real compile error, the retrospective says so and offers no button.

Notes:

- The analysis agent runs with **no tools** — it reasons only from the error, the captured output, and the workflow file, so it can never touch your project while a run is already failing. It uses whichever provider `EXECUTANT_PROVIDER` selects, so an OpenCode-only setup gets a retrospective too.
- If the analysis itself fails it is silently dropped; the original step error always propagates and the exit code is unchanged. Updating the task file does **not** turn a failed run into a successful one.
- It costs one API call per fatal failure, time-boxed to 120s so a stalled agent CLI can never hold the exit open. Disable with `--no-retrospective` or `EXECUTANT_RETROSPECTIVE=0`.
- `u` re-reads the task file from disk before refining, so edits made during the run (by you or by a step) aren't overwritten by a stale copy.
- Steps with `continue_on_error: true` don't end the run, so they don't produce a retrospective.
- In `--ci` mode the post-mortem is emitted as a `step:retrospective` NDJSON event instead of a pane; the update action is interactive-only.
- Remote (URL) workflows get the report but no update action — there is no local file to rewrite.

## Run Report

When a workflow finishes successfully, executant shows a run report — wall-clock duration, total API cost, total tokens (in/out/cache), and how much of that fell into Anthropic's long-context pricing tier:

```
run report:
  duration 4m 12s · cost $0.8341 · tokens 182,304 (12,000 over 200k in 1 call(s))
  [a] analyze this run for efficiency improvements · any other key to skip
```

Press **`a`** to run an efficiency analysis on demand — a Haiku call (no tools, up to 10 minutes) that reads what actually happened during the run (judge retries, self-healing fixes, failures) and suggests one concrete improvement to the task file:

```
  efficiency idea: write-tests needed a judge retry because the prompt didn't ask for an empty-input test case — add that to the prompt's requirements.
  press any key to exit
```

Any other key skips it and exits immediately.

Notes:

- **Duration, cost, and tokens are always shown** — they're free, pure aggregation over events the run already produced. Only the efficiency analysis costs an API call, and it's entirely opt-in: nothing runs unless you press `a`, so an automated or CI run is never disturbed by an API call it didn't ask for.
- **The analysis is grounded in what happened, not just the YAML.** It reads the run's own judge/self-healing history first — a step that needed a retry is direct evidence of where the prompting fell short — and falls back to a structural read of the task file (e.g. a `forEach` with no `concurrency:`) only when every step passed clean on the first attempt. It also judges whether the task file looks like a reusable template (parameterized `vars:`, used across repos) versus a one-off, and phrases the suggestion accordingly — general and prompt-focused for a template, concrete for a one-off.
- **Automate it** with `EXECUTANT_REPORT_SUGGESTION=1` — the analysis then runs automatically as part of the report (same Haiku call, same 10-minute cap) and the TUI shows the result directly instead of prompting for a keypress. Useful for a workflow you run unattended but still want the analysis from every time.
- **The overflow figure** counts tokens billed at the extended-context rate: the excess above 200,000 tokens, summed across every _individual_ call whose own context (input + cache) crossed that line. Many small calls that add up to a lot across a run never trigger it — only a single call that was that large, matching how the pricing tier is actually billed.
- **Not shown** for a cancelled run, a run that ends in a fatal step failure (see [failure retrospectives](#failure-retrospectives) instead), or for a nested `workflow:` sub-run — only the outermost run produces one report.
- The free part (duration/cost/tokens/overflow) is always written to the log file and, in `--ci` mode, emitted as a `workflow:report` NDJSON event immediately before `workflow:complete`. A suggestion appears there too only when generated automatically (`EXECUTANT_REPORT_SUGGESTION=1`) — the on-demand TUI analysis runs after the log file's report block is already written, so it's shown on screen but not persisted to the log.

## Statusline

Executant renders a context gauge above the TUI footer:

```
 executant   main  ━━━━━━━━━━ 81% 162.2k/200k
 └ repo      └ branch  └ how full the last step's context window was
```

The gauge is driven by the token usage of the **most recent Claude invocation executant spawned** — input + cache creation + cache read, the tokens that actually occupy a context window (output tokens don't). It is sized to the running step's model: 200k normally, 1M for a `[1m]` model. The bar turns amber past 70% and red past 90%. Repo and branch come from git (a detached HEAD shows the short SHA); outside a repository that segment is simply omitted.

**These are executant's numbers, not those of the Claude Code session you launched it from.** Each prompt step is a separate `claude -p` child with its own context window, and a parent session's context is not observable from a child process — so the gauge describes the last step executant ran.

There is nothing to configure and nothing to poll: the gauge is derived from the event stream and updates the moment a step reports its usage. Disable it with `EXECUTANT_STATUSLINE=0`.

## Observability

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and every run exports OpenTelemetry traces and metrics to an OTLP/HTTP collector (Jaeger, Grafana, Honeycomb, …):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 executant workflow.yaml
```

### Local quick start

To view traces locally, run a collector — for example Jaeger:

```bash
docker run --rm -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 executant workflow.yaml
```

Then open http://localhost:16686 and select the `executant` service. Note that
Jaeger accepts traces only — the metrics below are silently dropped. To see both,
use Grafana's all-in-one image instead (UI at http://localhost:3000, admin/admin;
traces land in Tempo, metrics in Prometheus):

```bash
docker run --rm -d --name lgtm -p 3000:3000 -p 4318:4318 grafana/otel-lgtm
```

Export `OTEL_EXPORTER_OTLP_ENDPOINT` in your shell profile to report every run
automatically; unset it and telemetry is completely off.

Each run produces one trace:

```
executant.run                  goal, task file, step count, total API cost
└─ <step name>                 per step — index, type, provider, model, cost
   │                           span events: tool, healing, judge
   └─ iteration N/M            per forEach / repeat iteration
```

- **Span events** — every tool invocation, self-healing attempt (phase, attempt count, exit code), and judge verdict (pass/fail, feedback) is recorded on its step's span. Tool inputs and step output text are never recorded as span events, keeping spans lean. One caveat: a failed step's error message — which for prompt steps can quote the step's final output lines — is recorded on the span, truncated to 1,000 characters.
- **Metrics** — `executant.step.duration` (histogram, ms), `executant.step.errors`, `executant.cost.usd` (by provider), `executant.healing.attempts`, and `executant.judge.verdicts`.
- **Cost caveats** — cost comes from Claude's reported `total_cost_usd`, attributed per step. Judge-evaluation calls run through a structured side channel that drops cost events, and OpenCode reports no cost at all — so totals undercount when either is in play.
- **`TRACEPARENT` propagation** — every subprocess (claude, opencode, script-step bash, and `forEach` shell commands) inherits a `TRACEPARENT` env var pointing at the current step's span, so OTel-instrumented tools inside your scripts join the same trace.
- **Flush on exit** — telemetry is flushed on every exit path: success, failure, cancellation, `q`, and SIGINT (exit 130). The shutdown flush and every in-flight OTLP request are capped at ~3 s, so an unreachable or unresponsive collector delays exit by a few seconds at most.
- **Zero overhead when off** — when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the OTel SDK is never even loaded.

`OTEL_SERVICE_NAME` overrides the exported service name (default `executant`).

## Examples

| File                      | Demonstrates                                        |
| ------------------------- | --------------------------------------------------- |
| `hello-world.yaml`        | Simple prompt steps                                 |
| `mixed-workflow.yaml`     | Script + prompt steps together                      |
| `foreach-demo.yaml`       | Inline lists and shell command iteration            |
| `nested-steps-demo.yaml`  | Multiple child steps per forEach / repeat iteration |
| `vars-demo.yaml`          | Variable substitution                               |
| `judge-demo.yaml`         | LLM-as-judge retry loop                             |
| `logging-demo.yaml`       | Log steps, self-healing, judge                      |
| `git-status-summary.yaml` | Real-world git workflow                             |
| `repeat-demo.yaml`        | Running a step N times with `repeat`                |
| `file-demo.yaml`          | File operations                                     |
| `from-step-test.yaml`     | Using `--from-step` to resume mid-workflow          |
| `workflow-step-parent.yaml` + `workflow-step-child.yaml` | Nested `workflow:` steps — stitching two taskfiles together |

See the [`examples/`](examples/) directory.

## CLI

```bash
executant plan "description"                    # generate a workflow YAML (auto-detects fast path)
executant plan -q "description"                 # skip research pass (fast path)
executant refine workflow.yaml "instructions"   # refine an existing workflow YAML
executant workflow.yaml                         # run a workflow
executant https://github.com/o/r/blob/main/w.yaml  # run a workflow from a URL
executant --ci workflow.yaml                    # headless, NDJSON to stdout
executant --step <name|n> wf.yaml              # run one step by name or index
executant --from-step <n> wf.yaml              # resume from step n
executant --to-step <n> wf.yaml                # stop after step n (inclusive)
executant --from-step 11 --to-step 14 wf.yaml  # run only steps 11-14
executant --var KEY=VALUE wf.yaml              # override a workflow var at runtime
executant update                                # upgrade to latest version
```

CI mode streams every runner event as one JSON object per line. The stream is additive: new event types (most recently `step:healing` and `step:judge`) and fields (a step `index` on `output:cost`) appear over time, so consumers should ignore event types and fields they don't recognise.

### Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| `0`  | All steps completed successfully              |
| `1`  | A step failed at runtime                      |
| `2`  | YAML or variable validation error             |
| `3`  | A step timed out (`timeout_seconds` exceeded) |
| `4`  | Cancelled via `.executant-cancel` file        |

## Development

```bash
npm test                                                     # run tests
npm run eval -- evals/plan-decompose.eval.yaml               # score a prompt template
npm run eval -- --refine evals/plan-decompose.eval.yaml      # refine until all cases pass
npm run eval -- --cases simple-feature,1-3 evals/plan-decompose.eval.yaml  # run a subset of cases
```

The eval system tests and iteratively refines the prompt templates in `src/prompts/`. Eval definitions live in `evals/*.eval.yaml`; see `AGENTS.md` for the full format.

Pass `--output-csv results/out.csv` to any eval run to save results. Re-running with the same path resumes from where it left off — already-scored cases are skipped.

### Multi-model comparison

```bash
# Run all evals × all configured models and generate a benchmark report
npm run eval:compare
npm run eval:compare:report   # regenerate report from existing CSVs

# Compare specific models on a single eval
npm run eval -- \
  --models claude/sonnet,opencode/llama-qwen7b/qwen2.5-coder-7b \
  --output-csv results/comparison.csv \
  evals/judge-evaluation.eval.yaml

# Run multiple eval files in one command
npm run eval -- evals/plan-decompose.eval.yaml evals/judge-evaluation.eval.yaml
```

The `--output-csv` file is denormalized (one row per criterion judgment per model) — ready for pivot tables and charts. See [docs/eval-comparison.md](docs/eval-comparison.md) for column definitions and interpretation guidance.

### Workflow evals (end-to-end agentic testing)

Workflow evals test models on complete coding tasks — the full development lifecycle — rather than just prompt quality. Each task runs in an isolated git worktree:

```
explore → plan → implement → npm test → commit
```

After the model finishes, Claude (always Claude, never the model being tested) reviews the git diff and judges it against the task criteria.

```bash
npm run eval:workflow -- --models claude/sonnet path/to/task.yaml
npm run eval:workflow -- \
  --models claude/sonnet,opencode/llama-qwen7b/qwen2.5-coder-7b \
  --output-csv results/workflow-comparison.csv \
  path/to/task.yaml
```

Task files are valid executant workflow YAMLs with an extra `eval_criteria` top-level field the harness reads for post-run judging.
