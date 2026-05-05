// ============================================================================
// COMMAND RUNNER
// ============================================================================
// Runs a bash command via child_process.spawn and streams output as events.
// stdout and stderr are merged and emitted line-by-line as output:text events.
// A non-zero exit code throws, which the workflow runner converts to step:error.

import { spawn } from 'node:child_process';
import type { CommandTask, Event } from '../types.js';
import { mergeStreamsToLines, waitForExit } from './stream.js';

export class CommandError extends Error {
  constructor(public readonly exitCode: number, public readonly command: string, message?: string) {
    super(message ?? `Command "${command}" exited with code ${exitCode}`);
    this.name = 'CommandError';
  }
}

/**
 * Yields output:text events for each line produced by the command.
 * Throws with the exit code on failure.
 */
export async function* runCommand(task: CommandTask): AsyncGenerator<Event> {
  yield { type: 'log', level: 'info', text: `$ ${task.command}` };

  const proc = spawn('bash', ['-c', task.command], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for await (const line of mergeStreamsToLines(proc.stdout!, proc.stderr!)) {
    // index: -1 here — runWorkflow patches it to the real step index
    yield { type: 'output:text', index: -1, text: line };
  }

  const code = await waitForExit(proc);
  if (code !== 0) {
    throw new CommandError(code, task.command, `Command "${task.name}" exited with code ${code}`);
  }
}

