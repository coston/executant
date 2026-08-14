#!/usr/bin/env node
// ============================================================================
// ENTRY POINT
// ============================================================================
// Usage:
//   executant path/to/workflow.yaml
//   executant --ci path/to/workflow.yaml   (NDJSON to stdout, no Ink)
//   executant update                       (upgrade to latest version)
//
// The --ci flag runs the same event stream in headless mode (NDJSON to stdout)
// instead of the Ink TUI, showing that the runner and UI are fully decoupled.

import React from "react";
import { render } from "ink";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadWorkflow, parseWorkflow } from "./load-workflow.js";
import {
  fetchWorkflowSource,
  isRemoteWorkflow,
  toRawUrl,
  workflowTaskName,
} from "./lib/remote-workflow.js";
import { resolveWorkflow } from "./resolve-workflow.js";
import { runWorkflow } from "./runner.js";
import { checkForUpdate } from "./update.js";
import { App } from "./ui/App.js";
import { parsePlanArgs, streamPlan } from "./plan.js";
import { parseRefineArgs, streamRefine } from "./refine.js";
import { PlanApp } from "./ui/PlanApp.js";
import {
  createLogger,
  findExecutantLocalDir,
  resolveLogDirFrom,
  withLogger,
} from "./logger.js";
import { InterjectChannel, TimeoutError } from "./types.js";
import type {
  FromStepTarget,
  Origin,
  Retrospective,
  RunOptions,
  Workflow,
} from "./types.js";
import { getErrorMessage, ignoreBrokenPipe } from "./lib/utils.js";
import { CURRENT_VERSION } from "./version.js";

// Must run before any output is written: a closed downstream pipe (VS Code
// recycling its terminal pty mid-session, or output piped into a command
// that exits early) otherwise crashes the process on the next write. See
// ignoreBrokenPipe for details.
ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

const rawArgs = process.argv.slice(2);

// executant plan — generate task YAML from description
if (rawArgs[0] === "plan") {
  const planArgs = parsePlanArgs(rawArgs.slice(1));
  const planEvents = streamPlan(planArgs);
  const inkApp = render(
    React.createElement(PlanApp, {
      description: planArgs.description,
      events: planEvents,
    }),
  );
  try {
    await inkApp.waitUntilExit();
  } catch {
    /* user quit or error — PlanApp already displayed it */
  }
  process.exit(0);
}

// executant refine — apply instructions to an existing task YAML
if (rawArgs[0] === "refine") {
  const refineArgs = parseRefineArgs(rawArgs.slice(1));
  const refineEvents = streamRefine(refineArgs);
  const inkApp = render(
    React.createElement(PlanApp, {
      description: refineArgs.description,
      events: refineEvents,
    }),
  );
  try {
    await inkApp.waitUntilExit();
  } catch {
    /* user quit or error — PlanApp already displayed it */
  }
  process.exit(0);
}

// executant update — upgrade in-place from GitHub
if (rawArgs[0] === "update") {
  const { checkForUpdate, doUpdate } = await import("./update.js");
  const newer = await checkForUpdate(CURRENT_VERSION);
  if (!newer) process.exit(0);
  console.log(`Updating to v${newer}...`);
  try {
    await doUpdate();
    console.log("Done.");
  } catch (err) {
    console.error("Update failed:", getErrorMessage(err));
    process.exit(1);
  }
  process.exit(0);
}

if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.log(`Usage: executant [options] <workflow.yaml | url>
       executant update

Version: ${CURRENT_VERSION}

Options:
  --ci                  Headless mode — print events as NDJSON, no TUI
  --step <name|index>   Run only the named step or step at 1-based index
  --from-step <n>       Resume from step n (e.g. 3, 3.2, 2.5.4.3 — 1-based path)
  --to-step <n>         Stop after step n (1-based top-level index, inclusive)
                        Combine with --from-step for a range, e.g.
                        --from-step 11 --to-step 14
  --var KEY=VALUE       Override or supply a workflow var at runtime (repeatable)
  --no-retrospective    Skip the post-mortem analysis when a step fails
  --help, -h            Show this help

Commands:
  plan <description>    Generate a task YAML from a natural language description
  refine <file> <inst>  Refine an existing task YAML with natural language instructions
  update                Upgrade executant to the latest version

YAML — top-level fields:
  goal    string   (required) Description shown in the TUI header
  steps   array    (required) Ordered list of steps
  vars    map      Key/value pairs substituted as {{var_name}} in prompts/commands

YAML — step fields (all step types):
  name              string  (required) Unique identifier for the step
  type              string  prompt | script | command | log | workflow  (inferred if omitted)
  continue_on_error bool    Keep going if step fails (default: false)
  forEach           string or list
                    Inline YAML array OR a shell command whose newline-split
                    stdout provides the items. {{item}} is substituted per
                    iteration in every child step's name, command, and prompt.
  repeat            int     Run this step N times; {{item}} is the 1-based
                    iteration number. Mutually exclusive with forEach.
  steps             list    Multiple child steps to run per forEach/repeat
                    iteration. Mutually exclusive with command/prompt on the
                    parent step. Requires forEach or repeat.
  context           list    Var names whose file-path values are prepended to
                    a prompt step's content at runtime.
  output            string  Var name naming a file path this step should
                    produce. Script steps: captures stdout to that file.
                    Prompt steps: the step fails if the file doesn't exist
                    when it finishes (checked, not captured — a prompt
                    step's real output is whatever it wrote via tool
                    calls). Not supported on log/workflow steps.

YAML — prompt step fields (type: prompt, or inferred when prompt is present):
  prompt            string  (required) Instructions sent to Claude
  allowed_tools     list    Claude tools to permit
                            (default: Read,Edit,Write,Bash,Glob,Grep)
  llm_as_judge      bool    After completion, Claude evaluates output quality;
                            retries up to 5x on FAIL (default: false)

YAML — script step fields (type: script | command, or inferred when command is present):
  command           string  (required) Bash command to execute
  self_healing      bool    On failure, Claude diagnoses and fixes iteratively
                            up to 5 attempts with accumulated context (default: false)
  max_healing_attempts  int   Override max self-healing retries (default: 5)
  timeout_seconds   number  Kill the step and fail with exit code 3 after N seconds

YAML — workflow step fields (type: workflow, or inferred when workflow is present):
  workflow          string  (required) Local path or URL to another workflow,
                            run as a self-contained nested sub-run. Relative
                            paths resolve against the referencing workflow's
                            own location (its directory, or its URL for a
                            remote workflow) — not the current directory.
  vars              map     Var overrides passed to the nested workflow.
  Not supported inside forEach/repeat. All nested workflows (however deep,
  local or remote) are fetched and validated before any step runs, so a bad
  reference anywhere in the chain fails fast at load time.

Remote workflows:
  The workflow argument may be an http(s) URL instead of a local path:
    executant https://github.com/owner/repo/blob/main/tasks/deploy.yaml
    executant https://gist.github.com/user/abc123
  GitHub blob and gist page URLs are rewritten to their raw equivalents.
  Private repos and gists use the token from your \`gh auth login\`.
  Remote workflows run in the current directory, and logs are written there.
  A remote workflow's own \`workflow:\` steps with a relative path resolve
  against its URL, never the local filesystem — even a reference that looks
  like an absolute local path.

Failure retrospectives:
  When a step fails and stops the run, executant explains why: root cause,
  evidence, and any task-file changes worth making. If the workflow itself is
  at fault it offers to apply the changes with \`refine\` (press u).
  Judge and self-healing history is included, so a step that dies to
  llm_as_judge is analysed against every verdict the judge gave.
  Skip it with --no-retrospective or EXECUTANT_RETROSPECTIVE=0.

Cancellation:
  Write a .executant-cancel file in the working directory to stop execution
  cleanly between steps (exit code 4). The file is deleted automatically.

Exit codes:
  0  All steps completed successfully
  1  A step failed at runtime
  2  YAML or variable validation error
  3  A step timed out (timeout_seconds exceeded)
  4  Cancelled via .executant-cancel file

YAML — log step fields (type: log, or inferred when message is present and prompt is absent):
  message           string  Text to emit as a progress marker

Type inference (when type is omitted):
  has workflow field         → workflow
  has command field          → script
  has message, no prompt     → log
  otherwise                  → prompt

Example:
  goal: "Check and summarise recent changes"
  steps:
    - name: git-log
      type: script
      command: git log --oneline -10

    - name: summarise
      prompt: |
        Summarise the 10 commits shown above in one short paragraph.
        Focus on the theme of changes, not individual commit messages.`);
  process.exit(0);
}

let ciMode = false;
let retrospective: boolean | undefined;
let stepFilter: string | undefined;
let fromStep: FromStepTarget | undefined;
let toStep: number | undefined;
const cliVars: Record<string, string> = {};
const positional: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--ci") {
    ciMode = true;
  } else if (a === "--no-retrospective") {
    retrospective = false;
  } else if (a === "--step") {
    if (!rawArgs[i + 1]) {
      console.error("--step requires a value");
      process.exit(1);
    }
    stepFilter = rawArgs[++i];
  } else if (a === "--from-step") {
    if (!rawArgs[i + 1]) {
      console.error("--from-step requires a value");
      process.exit(1);
    }
    const raw = rawArgs[++i];
    const parts = raw.split(".").map(Number);
    if (parts.some(Number.isNaN) || parts.some((p) => p < 1)) {
      console.error(
        "--from-step must be N or N.M.K... (all 1-based, e.g. 3 or 3.2 or 2.5.4.3)",
      );
      process.exit(1);
    }
    fromStep = parts;
  } else if (a === "--to-step") {
    if (!rawArgs[i + 1]) {
      console.error("--to-step requires a value");
      process.exit(1);
    }
    const raw = rawArgs[++i];
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      console.error("--to-step must be a 1-based integer, e.g. 14");
      process.exit(1);
    }
    toStep = value;
  } else if (a === "--var") {
    if (!rawArgs[i + 1]) {
      console.error("--var requires a KEY=VALUE argument");
      process.exit(1);
    }
    const pair = rawArgs[++i];
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      console.error(`--var value must be KEY=VALUE, got: ${pair}`);
      process.exit(1);
    }
    cliVars[pair.slice(0, eq)] = pair.slice(eq + 1);
  } else {
    positional.push(a);
  }
}

if (toStep !== undefined && fromStep !== undefined && toStep < fromStep[0]) {
  console.error(
    `--to-step (${toStep}) cannot be before --from-step (${fromStep[0]})`,
  );
  process.exit(1);
}

const source = positional[0];

if (!source) {
  console.error("Error: no workflow file specified");
  process.exit(1);
}

const remote = isRemoteWorkflow(source);

let workflow: Workflow;
try {
  const origin: Origin = remote
    ? { kind: "remote", url: toRawUrl(source) }
    : { kind: "local", dir: dirname(resolve(source)) };
  workflow = remote
    ? parseWorkflow(
        await fetchWorkflowSource(toRawUrl(source)),
        source,
        cliVars,
        origin,
      )
    : loadWorkflow(source, cliVars);
  workflow = await resolveWorkflow(workflow);
} catch (err) {
  console.error(getErrorMessage(err));
  process.exit(2);
}

// A remote workflow has no local directory of its own — it runs against
// wherever the user is standing.
const baseDir = remote ? process.cwd() : dirname(resolve(source));

// Auto-create task directories if this project uses executant's local dir layout.
const localDir = findExecutantLocalDir(baseDir);
if (localDir) {
  mkdirSync(join(localDir, "tasks", "todo"), { recursive: true });
  mkdirSync(join(localDir, "tasks", "done"), { recursive: true });
}
const options: RunOptions = {
  stepFilter,
  fromStep,
  toStep,
  workDir: baseDir,
  ...(retrospective !== undefined && { retrospective }),
};
const channel = new InterjectChannel();
const rawEvents = runWorkflow(workflow, options, channel);
const logger = createLogger(resolveLogDirFrom(baseDir), workflow.goal);
// Telemetry is opt-in via OTEL_EXPORTER_OTLP_ENDPOINT. The dynamic import
// keeps the OTel SDK entirely unloaded when it is off.
const telemetry = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  ? await (
      await import("./telemetry.js")
    ).createTelemetry(workflowTaskName(source))
  : null;
const events = telemetry
  ? withLogger(withLogger(rawEvents, logger), telemetry)
  : withLogger(rawEvents, logger);
// Flush telemetry before dying on a real SIGINT (CI / non-raw-mode terminals).
// Registered only when telemetry is on so default behavior is untouched.
if (telemetry) {
  process.once("SIGINT", () => {
    void telemetry.shutdown().finally(() => process.exit(130));
  });
}
// checkForUpdate can keep the event loop alive for up to 5s and its banner is
// only rendered by the TUI — skip it entirely in CI mode.
const updateCheck = ciMode
  ? Promise.resolve<string | null>(null)
  : checkForUpdate(CURRENT_VERSION);

/**
 * JSON.stringify replacer that serialises Error objects properly.
 * Without this, `new Error("oops")` becomes `{}` in JSON output.
 */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

if (ciMode) {
  // CI / headless mode: print each event as NDJSON, no terminal UI.
  // Useful for logs, piping into other tools, or running in a headless env.
  (async () => {
    for await (const event of events) {
      const line = JSON.stringify(event, errorReplacer) + "\n";
      if (event.type === "workflow:cancelled") {
        // Flush telemetry first — the write callback below exits the process.
        await telemetry?.shutdown();
        // Write then exit only after the data is flushed — process.exit() does
        // not drain buffered stdout on piped streams without this callback.
        process.stdout.write(line, () => process.exit(4));
        return;
      }
      process.stdout.write(line);
    }
    await telemetry?.shutdown();
  })().catch(async (err) => {
    const code = err instanceof TimeoutError ? 3 : 1;
    console.error(err);
    await telemetry?.shutdown();
    process.exit(code);
  });
} else {
  // Interactive mode: render the Ink TUI.
  // Set when the user accepts the retrospective's suggested task-file changes.
  // Applied after Ink exits — refine renders its own TUI and the two cannot
  // own the terminal at the same time.
  let pendingRefine: Retrospective | undefined;
  const inkApp = render(
    React.createElement(App, {
      workflow,
      events,
      options,
      updateCheck,
      interjectChannel: channel,
      onUpdateTaskFile: (retrospective) => {
        pendingRefine = retrospective;
      },
    }),
  );
  // waitUntilExit must be called synchronously after render — Ink installs the
  // exit resolver lazily and a late call can hang forever.
  const exitPromise = inkApp.waitUntilExit();
  try {
    await exitPromise;
  } catch {
    // Step failure: App already set process.exitCode (1 or 3). Catching here
    // stops an unhandled rejection from clobbering that exit code.
  }
  await telemetry?.shutdown();

  if (pendingRefine && workflow.sourcePath) {
    const taskFile = workflow.sourcePath;
    // Re-read from disk rather than reusing the copy loaded before the run.
    // refine overwrites the file wholesale, and a long run can edit its own
    // task file (or the user can) — regenerating from a stale snapshot would
    // silently discard those changes.
    let existingYaml: string;
    try {
      existingYaml = readFileSync(taskFile, "utf8");
    } catch (err) {
      console.error(
        `Cannot update "${taskFile}": ${getErrorMessage(err)}\n` +
          `Suggested change: ${pendingRefine.refineInstruction}`,
      );
      existingYaml = "";
    }
    const refineApp = existingYaml
      ? render(
          React.createElement(PlanApp, {
            description: workflow.goal,
            events: streamRefine({
              taskFile,
              existingYaml,
              instructions: pendingRefine.refineInstruction,
              description: workflow.goal,
            }),
          }),
        )
      : undefined;
    try {
      await refineApp?.waitUntilExit();
    } catch {
      /* refine failed — PlanApp already displayed it */
    }
    // The exit code still reflects the run: the workflow failed, and updating
    // the task file does not make that run a success.
  }
  // No process.exit — TUI exit relies on natural event-loop drain and the
  // process.exitCode set by App.
}
