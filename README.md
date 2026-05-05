<img width="1774" height="887" alt="e58fdd14-77a1-4207-99c2-fb8603e3f625" src="https://github.com/user-attachments/assets/8d57a6ee-0fd3-43c9-bdff-1538fe931337" />

# Executant

Harness for YAML-defined workflows that enables stepping through Claude sessions and bash commands.

## Advisory
Built for personal use by Coston. Public for sharing the approach. Use at your own risk. 

## Install

```bash
npm install -g executant
```

Requires [Node.js](https://nodejs.org) and the [Claude Code CLI](https://claude.ai/code).

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

## Quality Controls

- **`llm_as_judge: true`** — after a step completes, Claude evaluates the output; retries with feedback on FAIL, up to 5×
- **`self_healing: true`** — on script failure, Claude diagnoses and repairs the command, then re-runs it, up to 5×
- **`self_improve: true`** — after the workflow finishes, Claude analyzes execution highlights and saves an improved YAML to `tasks/backlog/`

## Examples

| File | Demonstrates |
|------|-------------|
| `hello-world.yaml` | Simple prompt steps |
| `mixed-workflow.yaml` | Script + prompt steps together |
| `foreach-demo.yaml` | Inline lists and shell command iteration |
| `vars-demo.yaml` | Variable substitution |
| `judge-demo.yaml` | LLM-as-judge retry loop |
| `logging-demo.yaml` | Log steps, self-healing, judge |
| `git-status-summary.yaml` | Real-world git workflow |

See the [`examples/`](examples/) directory.

## CLI

```bash
executant plan "description"          # generate a workflow YAML
executant workflow.yaml               # run a workflow
executant --ci workflow.yaml          # headless, NDJSON to stdout
executant --step <name|n> wf.yaml     # run one step by name or index
executant --from-step <n> wf.yaml     # resume from step n
executant update                      # upgrade to latest version
```

## Development

```bash
git clone https://github.com/coston/executant
cd executant
npm install
npm run dev examples/hello-world.yaml   # run without building
npm test                                 # run unit tests
```

## License

MIT
