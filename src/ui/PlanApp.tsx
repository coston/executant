// ============================================================================
// PLAN APP — Streaming TUI for plan generation
// ============================================================================
// Minimal Ink component that shows a spinner + live tool calls while Claude
// generates a workflow plan. Reuses LogPane for consistent output styling.

import React, { useEffect, useReducer, useState } from 'react';
import { Box, Text, useApp, useStdin } from 'ink';
import { KeyboardHandler } from './KeyboardHandler.js';
import { LogPane } from './LogPane.js';
import { useInterval } from './useInterval.js';
import { formatToolCall } from './formatTool.js';
import { SPINNER, EXIT_DELAY_MS, formatHeaderElapsed } from './utils.js';
import { theme } from './theme.js';
import { BrandMark } from './BrandMark.js';

const truncate = (str: string, max: number) => str.length > max ? str.slice(0, max - 3) + '...' : str;

// ----------------------------------------------------------------------------
// Events — simplified subset of the full Event type, just for plan generation
// ----------------------------------------------------------------------------

export type PlanEvent =
  | { type: 'plan:start'; description: string }
  | { type: 'plan:stages'; names: string[] }
  | { type: 'plan:stage'; stage: number; total: number; name: string }
  | { type: 'plan:tool'; tool: string; input: Record<string, unknown> }
  | { type: 'plan:text'; text: string }
  | { type: 'plan:warn'; message: string }
  | { type: 'plan:retry'; attempt: number; maxAttempts: number; reason: string }
  | { type: 'plan:complete'; taskFile: string; preview: string }
  | { type: 'plan:error'; message: string };

interface PlanState {
  description: string;
  lines: string[];
  status: 'running' | 'retrying' | 'complete' | 'error';
  attempt: number;
  maxAttempts: number;
  retryReason?: string;
  taskFile?: string;
  preview?: string;
  errorMessage?: string;
  startTime: number;
  stage: number;
  totalStages: number;
  stageName: string;
  stageNames: string[];
}

export function buildInitial(description: string): PlanState {
  return {
    description,
    lines: [],
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    startTime: Date.now(),
    stage: 0,
    totalStages: 0,
    stageName: '',
    stageNames: [],
  };
}

export function planReducer(state: PlanState, event: PlanEvent): PlanState {
  switch (event.type) {
    case 'plan:start':
      return { ...state, description: event.description, startTime: Date.now() };

    case 'plan:stages':
      return { ...state, stageNames: event.names, totalStages: event.names.length };

    case 'plan:stage': {
      const lines = [...state.lines, `[${event.stage}/${event.total}] ${event.name}`];
      return { ...state, stage: event.stage, totalStages: event.total, stageName: event.name, status: 'running', lines };
    }

    case 'plan:tool': {
      const formatted = formatToolCall(event.tool, event.input);
      if (!formatted) return state;
      return { ...state, lines: [...state.lines, formatted] };
    }

    case 'plan:text':
      return state; // text output is collected separately for JSON parsing

    case 'plan:warn': {
      const lines = [...state.lines, `[warn] ${event.message}`];
      return { ...state, lines };
    }

    case 'plan:retry': {
      const lines = [...state.lines, `[retry] Attempt ${event.attempt}/${event.maxAttempts}: ${event.reason}`];
      return { ...state, status: 'retrying', attempt: event.attempt, maxAttempts: event.maxAttempts, retryReason: event.reason, lines };
    }

    case 'plan:complete':
      return { ...state, status: 'complete', taskFile: event.taskFile, preview: event.preview };

    case 'plan:error':
      return { ...state, status: 'error', errorMessage: event.message };
  }
}

// ----------------------------------------------------------------------------
// StageProgress — vertical pipeline tracker
// ----------------------------------------------------------------------------

interface StageProgressProps {
  stage: number;
  totalStages: number;
  stageNames: string[];
  tick: number;
  isActive: boolean;
  status: PlanState['status'];
}

function StageProgress({ stage, totalStages, stageNames, tick, isActive, status }: StageProgressProps) {
  if (totalStages === 0 || stageNames.length === 0) return null;

  const rows = Array.from({ length: totalStages }, (_, i) => {
    const stageIndex = i + 1;
    const name = stageNames[i] ?? '';

    let icon: string;
    let color: string | undefined;
    let bold = false;
    let dim = false;

    if (stageIndex < stage) {
      icon = '✓';
      color = theme.success;
    } else if (stageIndex === stage && isActive) {
      icon = SPINNER[tick % SPINNER.length]!;
      color = theme.primary;
      bold = true;
    } else if (stageIndex === stage && !isActive) {
      icon = status === 'complete' ? '✓' : status === 'error' ? '✗' : '·';
      color = status === 'complete' ? theme.success : status === 'error' ? theme.error : undefined;
    } else if (!isActive && status === 'complete') {
      icon = '✓';
      color = theme.success;
    } else {
      icon = '·';
      dim = true;
    }

    return { icon, color, name, bold, dim };
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      {rows.map(({ icon, color, name, bold, dim }, i) => (
        <Box key={i}>
          <Text color={color} dimColor={dim} bold={bold}>  {icon}{name ? `  ${name}` : ''}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

interface Props {
  description: string;
  events: AsyncGenerator<PlanEvent>;
}

export function PlanApp({ description, events }: Props) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(planReducer, buildInitial(description));

  useEffect(() => {
    let active = true;
    (async () => {
      for await (const event of events) {
        if (!active) break;
        dispatch(event);
        if (event.type === 'plan:complete' || event.type === 'plan:error') {
          setTimeout(() => exit(), EXIT_DELAY_MS);
        }
      }
    })();
    return () => { active = false; };
  }, [events, exit]);

  const { isRawModeSupported } = useStdin();
  const [tick, setTick] = useState(0);
  const isActive = state.status === 'running' || state.status === 'retrying';
  useInterval(() => { if (isActive) setTick((t) => t + 1); }, 100);
  const elapsed = formatHeaderElapsed(state.startTime);
  const icon = isActive ? SPINNER[tick % SPINNER.length] : state.status === 'complete' ? '✓' : '✗';
  const iconColor = state.status === 'complete' ? theme.success : state.status === 'error' ? theme.error : theme.primary;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Brand */}
      <Box marginBottom={1}>
        <BrandMark tick={tick} isActive={isActive} />
      </Box>

      {/* Header */}
      <Box marginBottom={1}>
        <Text color={iconColor}>{icon} </Text>
        <Text bold color={theme.primary}>Generating plan</Text>
        <Text dimColor>{'  '}{elapsed}</Text>
        {state.status === 'retrying' && (
          <Text color={theme.warning}>{'  '}(attempt {state.attempt}/{state.maxAttempts})</Text>
        )}
      </Box>

      {/* Description */}
      <Box marginBottom={1}>
        <Text dimColor>  </Text>
        <Text>{truncate(state.description, 80)}</Text>
      </Box>

      {/* Stage progress */}
      <StageProgress
        stage={state.stage}
        totalStages={state.totalStages}
        stageNames={state.stageNames}
        tick={tick}
        isActive={isActive}
        status={state.status}
      />

      {/* Live tool calls */}
      {state.lines.length > 0 && (
        <LogPane lines={state.lines} isActive={isActive} maxLines={10} />
      )}

      {/* Result */}
      {state.status === 'complete' && state.taskFile && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.success}>✅ Task plan saved: {state.taskFile}</Text>
          {state.preview && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Preview:</Text>
              <Text>{state.preview}</Text>
            </Box>
          )}
        </Box>
      )}

      {state.status === 'error' && (
        <Box marginTop={1}>
          <Text color={theme.error}>Error: {state.errorMessage}</Text>
        </Box>
      )}

      {/* Footer */}
      {isActive && (
        <Box marginTop={1}>
          <Text dimColor>press q to quit</Text>
        </Box>
      )}

      {isRawModeSupported && <KeyboardHandler onExit={exit} />}
    </Box>
  );
}

