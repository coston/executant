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
  RunOptions,
  Workflow,
} from "../types.js";
import { getErrorMessage } from "../lib/utils.js";
import { reducer, buildInitialState } from "./reducer.js";
import { TaskRow } from "./TaskRow.js";
import { IterationList } from "./IterationRow.js";
import { LogPane } from "./LogPane.js";
import { useInterval } from "./useInterval.js";
import {
  countIterationRows,
  formatHeaderElapsed,
  EXIT_DELAY_MS,
} from "./utils.js";
import { theme } from "./theme.js";
import { BrandMark } from "./BrandMark.js";

interface Props {
  workflow: Workflow;
  events: AsyncGenerator<Event>;
  options?: RunOptions;
  updateCheck: Promise<string | null>;
  interjectChannel?: InterjectChannel;
}

const MAX_VISIBLE_ITERATIONS = 8;

export function App({
  workflow,
  events,
  options,
  updateCheck,
  interjectChannel,
}: Props) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, buildInitialState(workflow));
  const [isInterjecting, setIsInterjecting] = useState(false);

  // Consume the event stream. Each event updates state via the reducer.
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        for await (const event of events) {
          if (!active) break;
          dispatch(event);
          if (event.type === "workflow:complete") {
            // Leave the final state visible briefly, then exit.
            setTimeout(() => exit(), EXIT_DELAY_MS);
          }
        }
      } catch (err) {
        if (!active) return;
        dispatch({ type: "log", level: "error", text: getErrorMessage(err) });
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
  }, [events, exit]);

  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => {
    updateCheck.then(setUpdateVersion);
  }, [updateCheck]);

  // Tick counter drives spinner animation and live elapsed time in TaskRow.
  // Stops incrementing once the workflow finishes to avoid unnecessary renders.
  const [tick, setTick] = useState(0);
  useInterval(() => {
    if (!state.endTime) setTick((t) => t + 1);
  }, 100);

  // Compute how many log lines can fit without overflowing the terminal.
  // Overflow causes Ink to miscount its rendered height → text sprays above the UI.
  // Fixed overhead: outer padding(2) + brand+margin(2) + header+margin(2)
  // + taskList margin(1) + logPane marginTop+borders(3) + footer+margin(2) = 12 rows.
  const terminalRows = stdout?.rows ?? 24;
  const LOG_PANE_MIN = 5;

  // Count iteration rows rendered beneath the running forEach task.
  const runningTask = state.tasks.find((t) => t.status === "running");
  const iterationRowCount = countIterationRows(
    runningTask?.iterationHistory,
    MAX_VISIBLE_ITERATIONS,
  );

  // +1 when the update-available banner is showing; +1 when interject input is open
  const FIXED_OVERHEAD =
    12 + (updateVersion ? 1 : 0) + (isInterjecting ? 1 : 0);

  // Budget rows for the task list, leaving room for iteration rows + log pane minimum.
  const availableForTaskSection = Math.max(
    1,
    terminalRows - FIXED_OVERHEAD - LOG_PANE_MIN - iterationRowCount,
  );
  // Reserve 1 row for the "··· N earlier" indicator when truncating
  const visibleTaskCount =
    state.tasks.length > availableForTaskSection
      ? availableForTaskSection - 1
      : state.tasks.length;
  const taskSlice = state.tasks.slice(-visibleTaskCount);
  const hiddenTaskCount = state.tasks.length - taskSlice.length;

  const taskRowsUsed = visibleTaskCount + (hiddenTaskCount > 0 ? 1 : 0);
  const logPaneMaxLines = Math.max(
    LOG_PANE_MIN,
    terminalRows - FIXED_OVERHEAD - taskRowsUsed - iterationRowCount,
  );

  const elapsed = formatHeaderElapsed(state.startTime, state.endTime);
  const activeTask = state.tasks[state.currentIndex];
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

      {/* Task list */}
      <Box flexDirection="column" marginBottom={1}>
        {hiddenTaskCount > 0 && (
          <Text dimColor>
            {"  "}··· {hiddenTaskCount} earlier
          </Text>
        )}
        {taskSlice.map((taskState, i) => {
          const globalIndex = hiddenTaskCount + i;
          return (
            <Box key={globalIndex} flexDirection="column">
              <TaskRow
                index={globalIndex}
                tick={tick}
                taskState={taskState}
                isActive={globalIndex === state.currentIndex}
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
          );
        })}
      </Box>

      {/* Live output pane for the active task */}
      {activeTask && (
        <LogPane
          lines={activeTask.lines}
          isActive={activeTask.status === "running"}
          maxLines={logPaneMaxLines}
        />
      )}

      {/* Files written — shown after workflow completes */}
      {state.endTime !== undefined && state.writtenFiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>files written:</Text>
          {state.writtenFiles.map((f) => (
            <Text key={f} color={theme.primary}>
              {"  "}
              {f}
            </Text>
          ))}
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
        <Text dimColor>
          {isInterjecting
            ? "typing interjection…"
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
          isInterjecting={isInterjecting}
        />
      )}
    </Box>
  );
}
