// ============================================================================
// LOG PANE
// ============================================================================
// Shows the last N lines of the active task's output. Lines that look like
// tool calls (prefixed with "[ToolName]") get a distinct color so they stand
// out from plain text output.

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

interface Props {
  lines: string[];
  /** When true, shows a blinking cursor on the last line. */
  isActive?: boolean;
  /** Maximum visible lines. Defaults to 15. */
  maxLines?: number;
}

export function LogPane({ lines, isActive = false, maxLines = 15 }: Props) {
  const visible = lines.slice(-maxLines);

  if (visible.length === 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>
          {isActive ? "⠸ waiting for output…" : "— no output yet —"}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
    >
      {visible.map((line, i) => (
        <LogLine
          key={i}
          text={line}
          cursor={isActive && i === visible.length - 1}
        />
      ))}
    </Box>
  );
}

// ----------------------------------------------------------------------------
// Single line with syntax-aware coloring
// ----------------------------------------------------------------------------

function LogLine({ text, cursor }: { text: string; cursor?: boolean }) {
  const suffix = cursor ? <Text color={theme.primary}> ▌</Text> : null;

  // Tool call lines: "[Read] src/foo.ts"
  if (/^\[[\w:]+\]/.test(text)) {
    const bracket = text.match(/^\[[\w:]+\]/)?.[0] ?? "";
    const rest = text.slice(bracket.length);
    return (
      <Text>
        <Text color={theme.primary}>{bracket}</Text>
        <Text>{rest}</Text>
        {suffix}
      </Text>
    );
  }

  // Shell command echo: "$ cmd"
  if (/^\s*\$\s/.test(text))
    return (
      <Text color={theme.warning}>
        {text}
        {suffix}
      </Text>
    );

  // Explicit level prefixes from log events
  if (text.startsWith("[warn]"))
    return (
      <Text color={theme.warning}>
        {text}
        {suffix}
      </Text>
    );
  if (text.startsWith("[error]"))
    return (
      <Text color={theme.error}>
        {text}
        {suffix}
      </Text>
    );

  // Success markers from npm/yarn/tsc/etc — require no error/fail later on the same line
  if (
    /^[\s]*(✓|✔|✅|done|success|compiled|built|passed)/i.test(text) &&
    !/\b(error|fail|failed|warn|warning)\b/i.test(text)
  )
    return (
      <Text color={theme.success}>
        {text}
        {suffix}
      </Text>
    );

  // Error lines (case-insensitive word match to catch "Error:", "ERROR", "FAIL", etc.)
  if (/\b(error|failed|fail)\b/i.test(text))
    return (
      <Text color={theme.error}>
        {text}
        {suffix}
      </Text>
    );

  // Warning lines
  if (/\b(warn|warning)\b/i.test(text))
    return (
      <Text color={theme.warning}>
        {text}
        {suffix}
      </Text>
    );

  // Progress/noise lines from package managers (dimmed to reduce visual weight)
  if (/^[·…⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text))
    return (
      <Text color={theme.muted}>
        {text}
        {suffix}
      </Text>
    );

  return (
    <Text>
      {text}
      {suffix}
    </Text>
  );
}
