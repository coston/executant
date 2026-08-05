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
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadWorkflow } from "./load-workflow.js";
import { runWorkflow } from "./runner.js";
import { checkForUpdate } from "./update.js";
import { App } from "./ui/App.js";
import { parsePlanArgs, streamPlan } from "./plan.js";
import { parseRefineArgs, streamRefine } from "./refine.js";
import { PlanApp } from "./ui/PlanApp.js";
import {
  createLogger,
  findExecutantLocalDir,
  resolveLogDir,
  withLogger,
} from "./logger.js";
import { InterjectChannel, TimeoutError } from "./types.js";
import type { FromStepTarget, RunOptions, Workflow } from "./types.js";
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
  console.log(`Usage: executant [options] <workflow.yaml>
       executant update

Version: ${CURRENT_VERSION}

Options:
  --ci                  Headless mode — print events as NDJSON, no TUI
  --step <name|index>   Run only the named step or step at 1-based index
  --from-step <n>       Resume from step n (e.g. 3, 3.2, 2.5.4.3 — 1-based path)
  --var KEY=VALUE       Override or supply a workflow var at runtime (repeatable)
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
  type              string  prompt | script | command | log  (inferred if omitted)
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
  output            string  Var name; captures script stdout to that file path.

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
let stepFilter: string | undefined;
let fromStep: FromStepTarget | undefined;
const cliVars: Record<string, string> = {};
const positional: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--ci") {
    ciMode = true;
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

const filePath = positional[0];

if (!filePath) {
  console.error("Error: no workflow file specified");
  process.exit(1);
}

let workflow: Workflow;
try {
  workflow = loadWorkflow(filePath, cliVars);
} catch (err) {
  console.error(getErrorMessage(err));
  process.exit(2);
}

// Auto-create task directories if this project uses executant's local dir layout.
const localDir = findExecutantLocalDir(dirname(resolve(filePath)));
if (localDir) {
  mkdirSync(join(localDir, "tasks", "todo"), { recursive: true });
  mkdirSync(join(localDir, "tasks", "done"), { recursive: true });
}
const options: RunOptions = {
  stepFilter,
  fromStep,
  workDir: dirname(resolve(filePath)),
};
const channel = new InterjectChannel();
const rawEvents = runWorkflow(workflow, options, channel);
const logger = createLogger(resolveLogDir(filePath), workflow.goal);
// Telemetry is opt-in via OTEL_EXPORTER_OTLP_ENDPOINT. The dynamic import
// keeps the OTel SDK entirely unloaded when it is off.
const telemetry = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  ? await (await import("./telemetry.js")).createTelemetry(basename(filePath))
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
  const inkApp = render(
    React.createElement(App, {
      workflow,
      events,
      options,
      updateCheck,
      interjectChannel: channel,
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
  // No process.exit — TUI exit relies on natural event-loop drain and the
  // process.exitCode set by App.
}
