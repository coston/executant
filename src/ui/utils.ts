import type { TaskStatus } from '../types.js';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Delay before Ink unmounts to allow the final frame to render. */
export const EXIT_DELAY_MS = 300;

/** Elapsed time for workflow/plan headers. */
export function formatHeaderElapsed(start: number, end?: number): string {
  const ms = (end ?? Date.now()) - start;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Elapsed time for individual task rows — only shown when the task is active or finished. */
export function formatTaskElapsed(
  start: number | undefined,
  end: number | undefined,
  status: TaskStatus,
): string {
  if (!start) return '';
  const ms = (end ?? Date.now()) - start;
  if (status === 'running' || status === 'complete' || status === 'error') return `${(ms / 1000).toFixed(1)}s`;
  return '';
}
