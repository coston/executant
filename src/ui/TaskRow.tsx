import React from "react";
import { Box, Text } from "ink";
import type { TaskState } from "../types.js";
import { SPINNER, formatTaskElapsed } from "./utils.js";
import { theme } from "./theme.js";

interface Props {
  taskState: TaskState;
  isActive: boolean;
  index: number;
  tick: number;
}

export function TaskRow({ taskState, isActive, index, tick }: Props) {
  const { task, status, startTime, endTime } = taskState;

  const icon = statusIcon(status, tick);
  const color = statusColor(status, isActive);
  const elapsed = formatTaskElapsed(startTime, endTime, status);
  const iterInfo = taskState.iteration
    ? ` (${taskState.iteration.current}/${taskState.iteration.total}) ${taskState.iteration.item}`
    : "";
  const innerInfo = taskState.inner
    ? ` — ${taskState.inner.name} [${taskState.inner.index + 1}/${taskState.inner.total}]`
    : "";
  const label = `${index + 1}. ${task.name}${iterInfo}${innerInfo}`;

  return (
    <Box>
      <Text color={color}>{icon} </Text>
      <Text color={isActive ? theme.foreground : theme.muted} bold={isActive}>
        {label}
      </Text>
      <Text dimColor>
        {"  "}
        {elapsed}
      </Text>
    </Box>
  );
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const STATUS_ICON: Partial<Record<TaskState["status"], string>> = {
  complete: "✓",
  error: "✗",
  skipped: "⊘",
  pending: "·",
};

const STATUS_COLOR: Partial<Record<TaskState["status"], string>> = {
  complete: theme.success,
  error: theme.error,
  pending: theme.muted,
};

function statusIcon(status: TaskState["status"], tick: number): string {
  return status === "running"
    ? SPINNER[tick % SPINNER.length]
    : (STATUS_ICON[status] ?? "·");
}

function statusColor(status: TaskState["status"], isActive: boolean): string {
  if (isActive && status === "running") return theme.primary;
  return STATUS_COLOR[status] ?? theme.foreground;
}
