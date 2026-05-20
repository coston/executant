import React from "react";
import { Box, Text } from "ink";
import type { TaskState } from "../types.js";
import { STATUS_COLOR, formatTaskElapsed, statusIcon } from "./utils.js";
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
  const iterInfo = formatIterCount(taskState.iterationHistory);
  const label = `${index + 1}. ${task.name}${iterInfo}`;

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

function statusColor(status: TaskState["status"], isActive: boolean): string {
  if (isActive && status === "running") return theme.primary;
  return STATUS_COLOR[status] ?? theme.foreground;
}

function formatIterCount(history: TaskState["iterationHistory"]): string {
  if (!history?.length) return "";
  const total = history[0].total;
  const running = history.find((r) => r.status === "running");
  const current = running?.iteration ?? history.length;
  return ` (${current}/${total})`;
}
