// ============================================================================
// APP — Root Ink Component
// ============================================================================
// Subscribes to the event stream in a useEffect, feeds events into a
// useReducer, and renders the resulting ExecutionState. Nothing in this file
// knows how tasks execute — it only renders what the reducer tells it.

import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, useApp, useStdin, useStdout } from "ink";
import { KeyboardHandler } from "./KeyboardHandler.js";
import { InterjectInput } from "./InterjectInput.js";
import type {
  Event,
  InterjectChannel,
  Retrospective,
  RunOptions,
  RunReport,
  Workflow,
} from "../types.js";
import { RetrospectivePane } from "./RetrospectivePane.js";
import { ReportPrompt } from "./ReportPrompt.js";
import { TimeoutError } from "../types.js";
import { getErrorMessage } from "../lib/utils.js";
import { reducer, buildInitialState } from "./reducer.js";
import { TaskRow } from "./TaskRow.js";
import { IterationList } from "./IterationRow.js";
import { LogPane } from "./LogPane.js";
import { useInterval } from "./useInterval.js";
import { useStatusLine } from "./useStatusLine.js";
import { useOutputResize } from "./useOutputResize.js";
import {
  countIterationRows,
  formatHeaderElapsed,
  EXIT_DELAY_MS,
  MIN_OUTPUT_ROWS,
} from "./utils.js";
import { formatDuration, formatTokenCount } from "../lib/utils.js";
import { theme } from "./theme.js";
import { BrandMark } from "./BrandMark.js";

interface Props {
  workflow: Workflow;
  events: AsyncGenerator<Event>;
  options?: RunOptions;
  updateCheck: Promise<string | null>;
  interjectChannel?: InterjectChannel;
  /**
   * Called when the user accepts the retrospective's suggested task-file
   * changes. The TUI cannot run `refine` itself while Ink owns the terminal —
   * the caller applies it after the app exits.
   */
  onUpdateTaskFile?: (retrospective: Retrospective) => void;
}

const MAX_VISIBLE_ITERATIONS = 8;
// Floor for the retrospective pane's row budget on a very short terminal —
// below this it renders its chrome only and trims both lists to nothing.
const RETROSPECTIVE_MIN_ROWS = 10;
const MAX_VISIBLE_WRITTEN_FILES = 50;

export function App({
  workflow,
  events,
  options,
  updateCheck,
  interjectChannel,
  onUpdateTaskFile,
}: Props) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, buildInitialState(workflow));
  const [isInterjecting, setIsInterjecting] = useState(false);
  // True once a retrospective is on screen and waiting for the user to choose
  // an action. While set, the app deliberately does not exit on the failure.
  const [awaitingRetrospective, setAwaitingRetrospective] = useState(false);
  // True once a successful run's report is on screen with no suggestion yet
  // and the terminal can take input — ReportPrompt then owns the keyboard
  // and decides when to exit, instead of the usual auto-exit-after-delay.
  const [awaitingReportChoice, setAwaitingReportChoice] = useState(false);
  // Summed independently of the reducer, which intentionally drops cost
  // events — this is only for the statusline payload, not the task list.
  const [totalCostUsd, setTotalCostUsd] = useState(0);

  const { isRawModeSupported } = useStdin();

  // Consume the event stream. Each event updates state via the reducer.
  useEffect(() => {
    let active = true;
    // The retrospective arrives just before the runner rethrows. Remember it
    // here so the catch below knows to hand control to the pane instead of
    // tearing the TUI down a moment later.
    let interactiveRetrospective = false;
    // workflow:report arrives immediately before workflow:complete — stash it
    // here (dispatch's effect on state.report isn't guaranteed visible yet
    // inside this same synchronous handler) so the completion branch can
    // decide whether ReportPrompt has anything worth offering.
    let pendingReport: RunReport | undefined;

    (async () => {
      try {
        for await (const event of events) {
          if (!active) break;
          dispatch(event);
          if (event.type === "output:cost") {
            setTotalCostUsd((c) => c + event.usd);
          }
          if (event.type === "step:retrospective" && isRawModeSupported) {
            interactiveRetrospective = true;
            setAwaitingRetrospective(true);
          }
          if (event.type === "workflow:report") {
            pendingReport = event.report;
          }
          if (event.type === "workflow:complete") {
            // A suggestion is only worth offering when one wasn't already
            // generated automatically (EXECUTANT_REPORT_SUGGESTION=1) and the
            // terminal can actually take a keypress — otherwise fall back to
            // the usual "leave the final state visible briefly, then exit."
            if (
              isRawModeSupported &&
              pendingReport &&
              pendingReport.suggestion === undefined
            ) {
              setAwaitingReportChoice(true);
            } else {
              setTimeout(() => exit(), EXIT_DELAY_MS);
            }
          }
          if (event.type === "workflow:cancelled") {
            process.exitCode = 4;
            setTimeout(() => exit(), EXIT_DELAY_MS);
          }
        }
      } catch (err) {
        if (!active) return;
        dispatch({ type: "log", level: "error", text: getErrorMessage(err) });
        process.exitCode = err instanceof TimeoutError ? 3 : 1;
        // Exit code is already set; the pane exits once the user has read the
        // post-mortem and picked an action.
        if (interactiveRetrospective) return;
        setTimeout(
          () =>
            exit(err instanceof Error ? err : new Error(getErrorMessage(err))),
          EXIT_DELAY_MS,
        );
      }
    })();

    return () => {
      active = false;
      // Signal the async generator to stop, releasing any PTY/process resources.
      events.return(undefined).catch(() => {
        /* already finished */
      });
    };
  }, [events, exit, isRawModeSupported]);

  const { stdout } = useStdout();

  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => {
    updateCheck.then(setUpdateVersion);
  }, [updateCheck]);

  const statusLine = useStatusLine(workflow, totalCostUsd, state.startTime);

  // Tick counter drives spinner animation and live elapsed time in TaskRow.
  // Stops incrementing once the workflow finishes to avoid unnecessary renders.
  const [tick, setTick] = useState(0);
  useInterval(() => {
    if (!state.endTime) setTick((t) => t + 1);
  }, 100);

  // The step list is never trimmed — it's the primary view. The output pane
  // absorbs all the resizing: it shrinks to whatever room is left under a
  // full step list, down to MIN_OUTPUT_ROWS, instead of the old behavior of
  // hiding earlier steps to protect the pane's height.
  // Fixed overhead: outer padding(2) + brand+margin(2) + header+margin(2)
  // + taskList margin(1) + logPane marginTop+borders(3) + footer+margin(2) = 12 rows.
  const terminalRows = stdout?.rows ?? 24;

  // Count iteration rows rendered beneath the running forEach task.
  const runningTask = state.tasks.find((t) => t.status === "running");
  const iterationRowCount = countIterationRows(
    runningTask?.iterationHistory,
    MAX_VISIBLE_ITERATIONS,
  );

  // +1 when the update-available banner is showing; +1 when interject input is
  // open; +1 when the statusline has produced output
  const FIXED_OVERHEAD =
    12 +
    (updateVersion ? 1 : 0) +
    (isInterjecting ? 1 : 0) +
    (statusLine ? 1 : 0);

  const taskRowsUsed = state.tasks.length;

  // Room the output pane would get if it were purely auto-sized this frame.
  // This is also the ceiling for a user-fixed height: the pane can be frozen
  // smaller than this, but never so large it pushes the step list off screen.
  const autoOutputRows = Math.max(
    MIN_OUTPUT_ROWS,
    terminalRows - FIXED_OVERHEAD - taskRowsUsed - iterationRowCount,
  );

  const showOutputPane =
    !state.retrospective && Boolean(state.tasks[state.currentIndex]);
  // Boolean(...): ink's `isRawModeSupported` is `stdin.isTTY`, which Node
  // leaves `undefined` (not `false`) on a non-TTY stdin. useInput's isActive
  // option only treats a literal `false` as inactive — `undefined` defaults
  // to active — so this must never leak through the `&&` chain unboxed.
  const outputControlsEnabled = Boolean(
    showOutputPane &&
    isRawModeSupported &&
    !isInterjecting &&
    !awaitingRetrospective &&
    !awaitingReportChoice,
  );

  // Rows above/below the output pane's borders this frame — used only to
  // calibrate mouse-drag row math; must stay in step with FIXED_OVERHEAD.
  // Above: outer top padding(1) + brand+margin(2) + header+margin(2)
  // + step list rows(taskRowsUsed + iterationRowCount) + step list
  // margin(1) + pane's own top margin(1) = 7 + taskRowsUsed + iterationRowCount.
  const rowsAboveOutputPane = 7 + taskRowsUsed + iterationRowCount;
  // Below: footer margin(1) + hint line(1) + outer bottom padding(1), plus
  // whichever of the update banner / statusline / interject input show.
  const rowsBelowOutputPane =
    3 +
    (updateVersion ? 1 : 0) +
    (statusLine ? 1 : 0) +
    (isInterjecting ? 1 : 0);

  const { outputRows, scrollOffset, resetScroll } = useOutputResize({
    autoMaxRows: autoOutputRows,
    enabled: outputControlsEnabled,
    rowsAboveOutputPane,
    rowsBelowOutputPane,
  });

  // Re-pin to the live tail whenever the active step changes. Deliberately
  // keyed only on currentIndex — resetScroll's identity is stable (useCallback).
  useEffect(() => {
    resetScroll();
  }, [state.currentIndex, resetScroll]);

  // With the task list and log pane hidden, the pane gets every row the fixed
  // chrome does not need: padding(2) + brand+margin(2) + header+margin(2)
  // + footer+margin(2), plus the update banner when it is showing.
  const showRetrospective = Boolean(state.retrospective);
  const retrospectiveMaxRows = Math.max(
    RETROSPECTIVE_MIN_ROWS,
    terminalRows - 8 - (updateVersion ? 1 : 0) - (statusLine ? 1 : 0),
  );

  const elapsed = formatHeaderElapsed(state.startTime, state.endTime);
  const activeTask = state.tasks[state.currentIndex];
  // The step the retrospective is about — its captured output is what `o`
  // shows, so the user can check the analysis against what actually happened.
  const failedTask = state.tasks.find((t) => t.status === "error");
  const completedCount = state.tasks.filter(
    (t) => t.status === "complete",
  ).length;
  const totalCount = state.tasks.length;
  const filterInfo = options?.stepFilter
    ? `  [step: ${options.stepFilter}]`
    : options?.fromStep
      ? `  [from step: ${options.fromStep}]`
      : "";

  return (
    <Box flexDirection="column" padding={1}>
      {/* Brand */}
      <Box marginBottom={1}>
        <BrandMark tick={tick} isActive={!state.endTime} />
      </Box>

      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>
          {workflow.goal}
        </Text>
        <Text dimColor>
          {"  "}
          {completedCount}/{totalCount} steps · {elapsed}
          {filterInfo}
        </Text>
      </Box>

      {/* Task list — the primary view, always shown in full. Hidden once the
          retrospective takes over the screen. The run is finished and the
          pane names the step that ended it, so the rows are better spent on
          the post-mortem than on a frozen list. */}
      {!showRetrospective && (
        <Box flexDirection="column" marginBottom={1}>
          {state.tasks.map((taskState, index) => (
            <Box key={index} flexDirection="column">
              <TaskRow
                index={index}
                tick={tick}
                taskState={taskState}
                isActive={index === state.currentIndex}
              />
              {taskState.status === "running" &&
              taskState.iterationHistory?.length ? (
                <IterationList
                  iterationHistory={taskState.iterationHistory}
                  tick={tick}
                  maxVisible={MAX_VISIBLE_ITERATIONS}
                />
              ) : null}
            </Box>
          ))}
        </Box>
      )}

      {/* Live output pane for the active task. Replaced by the retrospective
          once one arrives — both at once would overflow the terminal. */}
      {state.retrospective ? (
        <RetrospectivePane
          retrospective={state.retrospective}
          sourcePath={workflow.sourcePath}
          maxRows={retrospectiveMaxRows}
          outputLines={failedTask?.lines}
          onAction={
            awaitingRetrospective
              ? (action) => {
                  if (action === "update" && state.retrospective)
                    onUpdateTaskFile?.(state.retrospective);
                  setAwaitingRetrospective(false);
                  exit();
                }
              : undefined
          }
        />
      ) : (
        activeTask && (
          <LogPane
            lines={activeTask.lines}
            isActive={activeTask.status === "running"}
            maxLines={outputRows}
            scrollOffset={scrollOffset}
          />
        )
      )}

      {/* Files written — shown after workflow completes (last N to bound the
          render tree; earlier entries are summarized). */}
      {state.endTime !== undefined && state.writtenFiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>files written:</Text>
          {state.writtenFiles.length > MAX_VISIBLE_WRITTEN_FILES && (
            <Text dimColor>
              {"  "}··· {state.writtenFiles.length - MAX_VISIBLE_WRITTEN_FILES}{" "}
              earlier
            </Text>
          )}
          {state.writtenFiles.slice(-MAX_VISIBLE_WRITTEN_FILES).map((f) => (
            <Text key={f} color={theme.primary}>
              {"  "}
              {f}
            </Text>
          ))}
        </Box>
      )}

      {/* Run report — shown once, after workflow:report fires on a
          successful completion (absent for cancelled/failed runs).
          Interactive (ReportPrompt) when the terminal supports input and no
          suggestion was already generated automatically; otherwise the plain
          stats-only block, matching non-interactive/CI-adjacent terminals. */}
      {state.report && awaitingReportChoice && (
        <ReportPrompt
          report={state.report}
          workflow={workflow}
          onDone={() => {
            setAwaitingReportChoice(false);
            exit();
          }}
        />
      )}
      {state.report && !awaitingReportChoice && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>run report:</Text>
          <Text dimColor>
            {"  "}duration {formatDuration(state.report.durationMs)} · cost $
            {state.report.totalCostUsd.toFixed(4)} · tokens{" "}
            {formatTokenCount(
              state.report.totalTokens.inputTokens +
                state.report.totalTokens.outputTokens +
                state.report.totalTokens.cacheCreationTokens +
                state.report.totalTokens.cacheReadTokens,
            )}
            {state.report.overflowCalls > 0
              ? ` (${formatTokenCount(state.report.overflowTokens)} over 200k in ${state.report.overflowCalls} call(s))`
              : ""}
          </Text>
          {state.report.suggestion && (
            <Text dimColor>
              {"  "}efficiency idea: {state.report.suggestion}
            </Text>
          )}
        </Box>
      )}

      {/* Interject input — shown when user presses i */}
      {isInterjecting && interjectChannel && (
        <InterjectInput
          onSubmit={(msg) => {
            interjectChannel.interject(msg);
            dispatch({
              type: "step:interjection",
              index: state.currentIndex,
              message: msg,
            });
            setIsInterjecting(false);
          }}
          onCancel={() => setIsInterjecting(false)}
        />
      )}

      {/* Footer */}
      <Box marginTop={1} flexDirection="column">
        {updateVersion && (
          <Text color={theme.warning}>
            v{updateVersion} available — run: executant update
          </Text>
        )}
        {statusLine && <Text dimColor>{statusLine}</Text>}
        <Text dimColor>
          {isInterjecting
            ? "typing interjection…"
            : awaitingRetrospective
              ? "↑↓ to choose  ·  enter to confirm  ·  o for the step output"
              : awaitingReportChoice
                ? ""
                : outputControlsEnabled
                  ? "press q to quit  ·  i to interject  ·  ↑↓ scroll output  ·  [ ] resize"
                  : "press q to quit  ·  i to interject"}
        </Text>
      </Box>

      {/* Keyboard handler — only mounted when stdin supports raw mode */}
      {isRawModeSupported && (
        <KeyboardHandler
          onExit={exit}
          onInterject={
            interjectChannel ? () => setIsInterjecting(true) : undefined
          }
          disabled={
            isInterjecting || awaitingRetrospective || awaitingReportChoice
          }
        />
      )}
    </Box>
  );
}
