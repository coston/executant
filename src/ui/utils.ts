import { formatDuration } from "../lib/utils.js";
import type { IterationRecord, TaskStatus } from "../types.js";
import { theme } from "./theme.js";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Icon glyphs shared across status-bearing rows (TaskRow, IterationRow). */
const STATUS_ICON: Partial<Record<TaskStatus, string>> = {
  complete: "✓",
  error: "✗",
  skipped: "⊘",
  pending: "·",
};

/** Colors shared across status-bearing rows. */
export const STATUS_COLOR: Partial<Record<TaskStatus, string>> = {
  complete: theme.success,
  error: theme.error,
  pending: theme.muted,
};

/** Resolves the spinner or status glyph for a given status and tick. */
export function statusIcon(status: string, tick: number): string {
  return status === "running"
    ? SPINNER[tick % SPINNER.length]!
    : (STATUS_ICON[status as TaskStatus] ?? "·");
}

/**
 * Number of terminal rows the IterationList will occupy for a given history.
 * Returns 0 for repeat-style steps (items === their iteration number) because
 * IterationList renders null in that case.
 */
export function countIterationRows(
  iterationHistory: IterationRecord[] | undefined,
  maxVisible: number,
): number {
  if (!iterationHistory?.length) return 0;
  if (iterationHistory.every((r) => r.item === String(r.iteration))) return 0;
  const visible = Math.min(iterationHistory.length, maxVisible);
  return visible + (iterationHistory.length > maxVisible ? 1 : 0);
}

/** Delay before Ink unmounts to allow the final frame to render. */
export const EXIT_DELAY_MS = 300;

/** Floor for the output pane's height — enough for its borders plus one line. */
export const MIN_OUTPUT_ROWS = 3;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Elapsed time for workflow/plan headers. */
export function formatHeaderElapsed(start: number, end?: number): string {
  return formatDuration((end ?? Date.now()) - start);
}

/** Elapsed time for individual task rows — only shown when the task is active or finished. */
export function formatTaskElapsed(
  start: number | undefined,
  end: number | undefined,
  status: TaskStatus,
): string {
  if (!start) return "";
  if (status === "running" || status === "complete" || status === "error")
    return formatDuration((end ?? Date.now()) - start);
  return "";
}
