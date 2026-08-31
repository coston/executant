// ============================================================================
// COMMAND RUNNER
// ============================================================================
// Runs a command via `sh -c` and streams output as events.
// Uses POSIX sh (not bash) so it works on macOS, Linux, and Alpine containers.
// stdout and stderr are merged and emitted line-by-line as output:text events.
// A non-zero exit code throws, which the workflow runner converts to step:error.

import { spawn } from "node:child_process";
import type { CommandTask, Event } from "../types.js";
import { mergeStreamsToLines, waitForExit, startTimeout } from "./stream.js";
import { traceparentEnv } from "../lib/trace-context.js";

export class CommandError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly command: string,
    message?: string,
  ) {
    super(message ?? `Command "${command}" exited with code ${exitCode}`);
    this.name = "CommandError";
  }
}

/**
 * Yields output:text events for each line produced by the command.
 * Throws with the exit code on failure, or TimeoutError if timeout_seconds elapses.
 */
export async function* runCommand(task: CommandTask): AsyncGenerator<Event> {
  yield { type: "log", level: "info", text: `$ ${task.command}` };

  const proc = spawn("sh", ["-c", task.command], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...traceparentEnv() },
    // `sh -c "<command>"` forks a real child for the command on shells like
    // dash whenever it isn't the single tail-callable command in the script
    // — killing just the sh PID then leaves that child running and holding
    // stdout/stderr open, so a reader waiting on EOF never sees one (this is
    // why a timed-out step used to hang instead of stopping). Detached makes
    // proc.pid the leader of its own process group, so signalling -proc.pid
    // reaches sh and every process it forked.
    detached: true,
  });

  // Detaching moves the child out of executant's own process group, so it no
  // longer receives a terminal's Ctrl+C (SIGINT) for free the way a
  // non-detached child would — these mirror that by killing the group
  // explicitly whenever executant itself is being torn down.
  const killGroup = (): void => {
    try {
      process.kill(-proc.pid!, "SIGTERM");
    } catch {
      /* already dead, or never got a pid */
    }
  };
  process.once("SIGINT", killGroup);
  process.once("SIGTERM", killGroup);
  process.once("SIGHUP", killGroup);

  const timeout = startTimeout(proc, task.name, task.timeoutSeconds, killGroup);

  try {
    for await (const line of mergeStreamsToLines(proc.stdout!, proc.stderr!)) {
      // index: -1 here — runWorkflow patches it to the real step index
      yield { type: "output:text", index: -1, text: line };
    }

    const code = await waitForExit(proc);
    timeout.check();
    if (code !== 0) {
      throw new CommandError(
        code,
        task.command,
        `Command "${task.name}" exited with code ${code}`,
      );
    }
  } finally {
    timeout.cancel();
    process.off("SIGINT", killGroup);
    process.off("SIGTERM", killGroup);
    process.off("SIGHUP", killGroup);
  }
}
