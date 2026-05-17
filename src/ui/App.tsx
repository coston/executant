// ============================================================================
// APP — Root Ink Component
// ============================================================================
// Subscribes to the event stream in a useEffect, feeds events into a
// useReducer, and renders the resulting ExecutionState. Nothing in this file
// knows how tasks execute — it only renders what the reducer tells it.

import React, { useEffect, useReducer, useState } from 'react';
import { Box, Text, useApp, useStdin } from 'ink';
import { KeyboardHandler } from './KeyboardHandler.js';
import type { Event, RunOptions, Workflow } from '../types.js';
import { getErrorMessage } from '../lib/utils.js';
import { reducer, buildInitialState } from './reducer.js';
import { TaskRow } from './TaskRow.js';
import { LogPane } from './LogPane.js';
import { useInterval } from './useInterval.js';
import { formatHeaderElapsed, EXIT_DELAY_MS } from './utils.js';
import { theme } from './theme.js';
import { BrandMark } from './BrandMark.js';

interface Props {
  workflow: Workflow;
  events: AsyncGenerator<Event>;
  options?: RunOptions;
  updateCheck: Promise<string | null>;
}

export function App({ workflow, events, options, updateCheck }: Props) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, buildInitialState(workflow));

  // Consume the event stream. Each event updates state via the reducer.
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        for await (const event of events) {
          if (!active) break;
          dispatch(event);
          if (event.type === 'workflow:complete') {
            // Leave the final state visible briefly, then exit.
            setTimeout(() => exit(), EXIT_DELAY_MS);
          }
        }
      } catch (err) {
        if (!active) return;
        dispatch({ type: 'log', level: 'error', text: getErrorMessage(err) });
        setTimeout(() => exit(err instanceof Error ? err : new Error(getErrorMessage(err))), EXIT_DELAY_MS);
      }
    })();

    return () => {
      active = false;
      // Signal the async generator to stop, releasing any PTY/process resources.
      events.return(undefined).catch(() => { /* already finished */ });
    };
  }, [events, exit]);

  const { isRawModeSupported } = useStdin();

  // Tick counter drives spinner animation and live elapsed time in TaskRow.
  // Stops incrementing once the workflow finishes to avoid unnecessary renders.
  const [tick, setTick] = useState(0);
  useInterval(() => { if (!state.endTime) setTick((t) => t + 1); }, 100);

  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => { updateCheck.then(setUpdateVersion); }, [updateCheck]);

  const elapsed = formatHeaderElapsed(state.startTime, state.endTime);
  const activeTask = state.tasks[state.currentIndex];
  const completedCount = state.tasks.filter((t) => t.status === 'complete').length;
  const totalCount = state.tasks.length;
  const filterInfo = options?.stepFilter
    ? `  [step: ${options.stepFilter}]`
    : options?.fromStep
    ? `  [from step: ${options.fromStep}]`
    : '';

  return (
    <Box flexDirection="column" padding={1}>
      {/* Brand */}
      <Box marginBottom={1}>
        <BrandMark tick={tick} isActive={!state.endTime} />
      </Box>

      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>{workflow.goal}</Text>
        <Text dimColor>{'  '}{completedCount}/{totalCount} steps · {elapsed}{filterInfo}</Text>
      </Box>

      {/* Task list */}
      <Box flexDirection="column" marginBottom={1}>
        {state.tasks.map((taskState, i) => (
          <TaskRow
            key={taskState.task.name}
            index={i}
            tick={tick}
            taskState={taskState}
            isActive={i === state.currentIndex}
          />
        ))}
      </Box>

      {/* Live output pane for the active task */}
      {activeTask && (
        <LogPane lines={activeTask.lines} isActive={activeTask.status === 'running'} />
      )}

      {/* Files written — shown after workflow completes */}
      {state.endTime !== undefined && state.writtenFiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>files written:</Text>
          {state.writtenFiles.map((f) => (
            <Text key={f} color={theme.primary}>{'  '}{f}</Text>
          ))}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} flexDirection="column">
        {updateVersion && (
          <Text color={theme.warning}>v{updateVersion} available — run: executant update</Text>
        )}
        <Text dimColor>press q to quit</Text>
      </Box>

      {/* Keyboard handler — only mounted when stdin supports raw mode */}
      {isRawModeSupported && <KeyboardHandler onExit={exit} />}
    </Box>
  );
}

