import React from "react";
import { Box, Text } from "ink";
import type { IterationRecord } from "../types.js";
import { STATUS_COLOR, statusIcon } from "./utils.js";
import { theme } from "./theme.js";

interface RowProps {
  record: IterationRecord;
  tick: number;
}

function IterationRow({ record, tick }: RowProps) {
  const icon = statusIcon(record.status, tick);
  const color = STATUS_COLOR[record.status] ?? theme.primary;
  const innerText = record.inner
    ? ` — ${stripItem(record.inner.name, record.item)} [${record.inner.index + 1}/${record.inner.total}]`
    : "";
  const ms = (record.endTime ?? Date.now()) - record.startTime;
  const elapsed = `${(ms / 1000).toFixed(1)}s`;

  return (
    <Box>
      <Text dimColor>{"    "}</Text>
      <Text color={color}>{icon}</Text>
      <Text> </Text>
      <Text
        color={record.status === "running" ? theme.foreground : theme.muted}
      >
        {record.item}
        {innerText}
      </Text>
      <Text dimColor>
        {"  "}
        {elapsed}
      </Text>
    </Box>
  );
}

interface ListProps {
  iterationHistory: IterationRecord[];
  tick: number;
  maxVisible: number;
}

/**
 * Removes the item text from an inner step name to avoid redundant display.
 * e.g. "review src/foo.ts" with item "src/foo.ts" → "review"
 * Falls back to the original name if stripping leaves nothing.
 */
function stripItem(name: string, item: string): string {
  if (!name.includes(item)) return name;
  const stripped = name
    .replace(item, "")
    .replace(/\s{2,}/g, " ") // collapse double spaces
    .replace(/^[\s\-—–]+/, "") // strip leading separators
    .replace(/[\s\-—–]+$/, "") // strip trailing separators
    .trim();
  return stripped || name;
}

/**
 * Returns true when every item is just its 1-based iteration number —
 * the signature of a `repeat:` step. In that case the parent row's (N/M)
 * already shows all available information, so expanding adds nothing.
 */
function isRepeatStyle(history: IterationRecord[]): boolean {
  return history.every((r) => r.item === String(r.iteration));
}

export function IterationList({
  iterationHistory,
  tick,
  maxVisible,
}: ListProps) {
  if (isRepeatStyle(iterationHistory)) return null;

  const hidden = iterationHistory.length - maxVisible;
  const visible = iterationHistory.slice(-maxVisible);
  return (
    <>
      {hidden > 0 && <Text dimColor>{`    … ${hidden} earlier`}</Text>}
      {visible.map((record) => (
        <IterationRow key={record.iteration} record={record} tick={tick} />
      ))}
    </>
  );
}
