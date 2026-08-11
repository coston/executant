// ============================================================================
// RETROSPECTIVE PANE
// ============================================================================
// Rendered after a fatal step failure, once the runner has produced a
// post-mortem. Shows the root cause and the suggested workflow changes, and
// offers the user a choice of actions (arrow keys + enter, or the shortcut
// letter). The pane owns keyboard input while it is interactive, so App
// disables its own KeyboardHandler for the duration.

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Retrospective } from "../types.js";
import { theme } from "./theme.js";

type RetrospectiveAction = "update" | "dismiss";

interface Props {
  retrospective: Retrospective;
  /**
   * Path of the workflow file the "update" action would refine. Absent for
   * remote or in-memory workflows — the update action is then not offered.
   */
  sourcePath?: string;
  /** Terminal rows the pane may occupy. Lists are trimmed to fit. */
  maxRows: number;
  /** The failing step's output lines, shown in full when the user presses `o`. */
  outputLines?: string[];
  onAction?: (action: RetrospectiveAction) => void;
}

const SEVERITY_COLOR: Record<string, string> = {
  high: theme.error,
  medium: theme.warning,
  low: theme.muted,
};

// Rows the pane always spends: borders, title, summary, the root-cause block,
// the section headers, and the margins between them — plus slack for the
// summary and root cause wrapping onto a second line each.
const CHROME_ROWS = 10;
// An evidence entry renders as one line, a suggestion as two (issue + change).
// Long entries wrap, so these are floors; the CHROME_ROWS slack absorbs it.
// Overflowing makes Ink miscount its height and spray text above the UI, so
// when in doubt show less.
const ROWS_PER_EVIDENCE = 1;
const ROWS_PER_SUGGESTION = 2;
// Even on a tall terminal the pane is a summary, not the log file.
const MAX_VISIBLE_EVIDENCE = 4;
const MAX_VISIBLE_SUGGESTIONS = 4;

/**
 * Chooses how many evidence lines and suggestions fit in the given number of
 * terminal rows. Suggestions win the remaining space: they are the actionable
 * half, and the full report is always in the run's log file.
 */
export function fitLists(
  evidenceCount: number,
  suggestionCount: number,
  maxRows: number,
  actionRows: number,
): { evidence: number; suggestions: number } {
  const budget = Math.max(0, maxRows - CHROME_ROWS - actionRows);
  const suggestions = Math.min(
    suggestionCount,
    MAX_VISIBLE_SUGGESTIONS,
    Math.floor(budget / ROWS_PER_SUGGESTION),
  );
  const left = budget - suggestions * ROWS_PER_SUGGESTION;
  return {
    evidence: Math.min(
      evidenceCount,
      MAX_VISIBLE_EVIDENCE,
      Math.floor(left / ROWS_PER_EVIDENCE),
    ),
    suggestions,
  };
}

/** Which actions the user can take, given whether a local file can be updated. */
export function availableActions(
  retrospective: Retrospective,
  sourcePath?: string,
): Array<{ id: RetrospectiveAction; key: string; label: string }> {
  const update =
    retrospective.workflowFixable && sourcePath
      ? [
          {
            id: "update" as const,
            key: "u",
            label: "Update the task file with these changes",
          },
        ]
      : [];
  return [...update, { id: "dismiss" as const, key: "d", label: "Dismiss" }];
}

export function RetrospectivePane({
  retrospective,
  sourcePath,
  maxRows,
  outputLines = [],
  onAction,
}: Props) {
  const actions = availableActions(retrospective, sourcePath);
  const [selected, setSelected] = useState(0);
  // The analysis is a reading of the output, not the output itself. `o` shows
  // the raw lines so the user can check that reading against what happened.
  const [showingOutput, setShowingOutput] = useState(false);

  useInput(
    (input, key) => {
      if (input.toLowerCase() === "o" && outputLines.length > 0) {
        setShowingOutput((v) => !v);
        return;
      }
      if (key.upArrow || key.leftArrow)
        setSelected((i) => (i - 1 + actions.length) % actions.length);
      if (key.downArrow || key.rightArrow)
        setSelected((i) => (i + 1) % actions.length);
      if (key.return) onAction?.(actions[selected].id);
      const shortcut = actions.find((a) => a.key === input.toLowerCase());
      if (shortcut) onAction?.(shortcut.id);
      if (key.escape || input === "q") onAction?.("dismiss");
    },
    { isActive: Boolean(onAction) },
  );

  const fit = fitLists(
    retrospective.evidence.length,
    retrospective.suggestions.length,
    maxRows,
    onAction ? actions.length + 1 : 0,
  );
  // Output view: title + section header + the action rows, rest is output.
  const outputRows = Math.max(
    1,
    maxRows - 4 - (onAction ? actions.length + 1 : 0),
  );
  const evidence = retrospective.evidence.slice(0, fit.evidence);
  const suggestions = retrospective.suggestions.slice(0, fit.suggestions);
  const hidden =
    retrospective.evidence.length -
    evidence.length +
    (retrospective.suggestions.length - suggestions.length);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.error}
    >
      <Text bold color={theme.error}>
        retrospective — {retrospective.step}
      </Text>

      {showingOutput ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>output from {retrospective.step}</Text>
          {outputLines.slice(-outputRows).map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      ) : (
        <>
          <Box marginTop={1}>
            <Text>{retrospective.summary}</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text dimColor>root cause</Text>
            <Text>{retrospective.rootCause}</Text>
          </Box>

          {evidence.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>evidence</Text>
              {evidence.map((line, i) => (
                <Text key={i} dimColor>
                  {"  · "}
                  {line}
                </Text>
              ))}
            </Box>
          )}

          {suggestions.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>task file</Text>
              {suggestions.map((s, i) => (
                <Box key={i} flexDirection="column">
                  <Text color={SEVERITY_COLOR[s.severity] ?? theme.muted}>
                    {"  · "}
                    {s.step ? `${s.step}: ` : ""}
                    {s.issue}
                  </Text>
                  <Text dimColor>
                    {"    → "}
                    {s.change}
                  </Text>
                </Box>
              ))}
            </Box>
          )}

          {hidden > 0 && (
            <Text dimColor>
              {"  ··· "}
              {hidden} more — full report in the run log
            </Text>
          )}

          {!retrospective.workflowFixable && (
            <Box marginTop={1}>
              <Text dimColor>
                No workflow change would have prevented this — fix the
                underlying issue and re-run.
              </Text>
            </Box>
          )}
        </>
      )}

      {onAction && (
        <Box marginTop={1} flexDirection="column">
          {actions.map((a, i) => (
            <Text
              key={a.id}
              color={i === selected ? theme.primary : undefined}
              bold={i === selected}
            >
              {i === selected ? "❯ " : "  "}[{a.key}] {a.label}
            </Text>
          ))}
          {outputLines.length > 0 && (
            <Text dimColor>
              {"  "}[o]{" "}
              {showingOutput ? "back to the analysis" : "show the step output"}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
