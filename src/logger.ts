// ============================================================================
// EXECUTION LOGGER
// ============================================================================
//
// Subscribes to the runner's event stream and writes:
//   - A full timestamped execution log (.log file)
//   - Highlight files for judge verdicts, self-healing activations, and
//     complex tool sequences (3+ tools in one step)
//   - A highlights/README.md index updated after each run
//
// Logging is ENABLED by default. Disable with EXECUTANT_LOG=0.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Event } from './types.js';
import { slugify, formatTimestamp, getErrorMessage } from './lib/utils.js';

// ============================================================================
// Log directory resolution
// ============================================================================

export function findExecutantLocalDir(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, '.claude', 'executant.local');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveLogDir(workflowFilePath: string): string {
  const startDir = dirname(resolve(workflowFilePath));
  const executantLocal = findExecutantLocalDir(startDir);
  return executantLocal ? join(executantLocal, 'logs') : join(startDir, 'logs');
}

// ============================================================================
// State machine
// ============================================================================

/** Fixed values determined at logger creation — never change across events. */
interface LogContext {
  readonly logDir: string;
  readonly highlightsDir: string;
  readonly ts: string;
  readonly slug: string;
}

/** Mutable snapshot replaced (not mutated) on each event. */
interface LogState {
  readonly logFile: string;
  readonly stepIndex: number;
  readonly stepName: string;
  readonly stepStartMs: number;
  readonly toolCount: number;
  readonly complexSequenceFile: string;
  readonly selfHealingFile: string;
  readonly judgeAttempt: number;
  readonly recentOutput: readonly string[];
}

const INIT_STATE: LogState = {
  logFile: '',
  stepIndex: -1,
  stepName: '',
  stepStartMs: 0,
  toolCount: 0,
  complexSequenceFile: '',
  selfHealingFile: '',
  judgeAttempt: 0,
  recentOutput: [],
};

// ============================================================================
// Pure handlers — each performs its side-effects and returns the new state
// ============================================================================

const TOOL_SUMMARY: Record<string, (i: Record<string, unknown>) => string> = {
  Read:  (i) => String(i['file_path'] ?? i['path'] ?? ''),
  Edit:  (i) => String(i['file_path'] ?? ''),
  Write: (i) => String(i['file_path'] ?? ''),
  Bash:  (i) => String(i['command'] ?? ''),
  Glob:  (i) => String(i['pattern'] ?? ''),
  Grep:  (i) => String(i['pattern'] ?? ''),
};

function toolSummary(tool: string, input: Record<string, unknown>): string {
  return (TOOL_SUMMARY[tool] ?? ((i: Record<string, unknown>) => JSON.stringify(i)))(input);
}

function appendLog(logFile: string, text: string): void {
  if (logFile) appendFileSync(logFile, text + '\n');
}

function highlightPath(ctx: LogContext, stepIndex: number, suffix: string): string {
  return join(ctx.highlightsDir, `${ctx.ts}_step${stepIndex + 1}_${suffix}.md`);
}

function onWorkflowStart(ctx: LogContext, s: LogState): LogState {
  mkdirSync(ctx.logDir, { recursive: true });
  mkdirSync(ctx.highlightsDir, { recursive: true });
  const logFile = join(ctx.logDir, `${ctx.ts}_${ctx.slug}.log`);
  writeFileSync(logFile, `# Execution Log\nTask: ${ctx.slug}\nStarted: ${new Date().toISOString()}\n${'━'.repeat(51)}\n\n`);
  return { ...s, logFile };
}

function onStepStart(ctx: LogContext, s: LogState, index: number, name: string): LogState {
  const next: LogState = { ...INIT_STATE, logFile: s.logFile, stepIndex: index, stepName: name, stepStartMs: Date.now() };
  appendLog(next.logFile, `\n${'━'.repeat(51)}\nStep ${index + 1}: ${name}\nStarted: ${new Date().toISOString()}\n${'━'.repeat(51)}\n`);
  return next;
}

function finalizeComplexSequence(s: LogState): void {
  if (s.toolCount >= 3 && s.complexSequenceFile) {
    appendFileSync(s.complexSequenceFile, `\n---\n\n*Total tools used: ${s.toolCount}*\n\n*Captured by Executant Logger*\n`);
  }
}

function onStepComplete(s: LogState): LogState {
  appendLog(s.logFile, `\nStep completed in ${((Date.now() - s.stepStartMs) / 1000).toFixed(1)}s\n`);
  finalizeComplexSequence(s);
  return s;
}

function onStepError(s: LogState, error: Error): LogState {
  appendLog(s.logFile, `\nStep failed: ${error.message}\n`);
  finalizeComplexSequence(s);
  return s;
}

function complexSequenceHeader(ctx: LogContext, s: LogState): string {
  return [
    '# Complex Tool Sequence', '',
    `**Task:** ${ctx.slug}`, `**Step:** ${s.stepName}`,
    `**Timestamp:** ${new Date().toISOString()}`, '', '---', '',
    "## Claude's Tool Orchestration", '', 'Claude used multiple tools to complete this step:', '',
  ].join('\n');
}

function createComplexSequenceFile(ctx: LogContext, s: LogState): string {
  const path = highlightPath(ctx, s.stepIndex, 'complex_sequence');
  writeFileSync(path, complexSequenceHeader(ctx, s));
  return path;
}

function onTool(ctx: LogContext, s: LogState, tool: string, input: Record<string, unknown>): LogState {
  const desc = toolSummary(tool, input);
  appendLog(s.logFile, `   [${tool}] ${desc}`);
  const toolCount = s.toolCount + 1;
  const complexSequenceFile = toolCount === 3 ? createComplexSequenceFile(ctx, s) : s.complexSequenceFile;
  if (toolCount >= 3 && complexSequenceFile) {
    appendFileSync(complexSequenceFile, `${toolCount}. **${tool}** - ${desc}\n`);
  }
  return { ...s, toolCount, complexSequenceFile };
}

function saveJudgeHighlight(ctx: LogContext, s: LogState, verdict: 'PASS' | 'FAIL', text: string): void {
  writeFileSync(highlightPath(ctx, s.stepIndex, `judge_${verdict}`), [
    `# Judge Verdict: ${verdict}`, '',
    `**Task:** ${ctx.slug}`, `**Step:** ${s.stepName}`,
    `**Attempt:** ${s.judgeAttempt}`, `**Timestamp:** ${new Date().toISOString()}`,
    '', '---', '', text, '', '---', '', '*Auto-captured*', '',
  ].join('\n'));
}

interface LogMatcher {
  readonly pattern: RegExp;
  readonly apply: (ctx: LogContext, s: LogState, text: string, match: RegExpExecArray) => LogState;
}

const LOG_MATCHERS: readonly LogMatcher[] = [
  {
    pattern: /\[judge\]\s+(PASS|FAIL)/i,
    apply: (ctx, s, text, match) => {
      const verdict = match[1].toUpperCase() as 'PASS' | 'FAIL';
      const judgeAttempt = s.judgeAttempt + 1;
      saveJudgeHighlight(ctx, { ...s, judgeAttempt }, verdict, text);
      return { ...s, judgeAttempt };
    },
  },
  {
    pattern: /\[self-healing\].*failed.*exit\s+(\d+)/i,
    apply: (ctx, s, text, match) => {
      const selfHealingFile = highlightPath(ctx, s.stepIndex, 'self_healing');
      writeFileSync(selfHealingFile, [
        '# Self-Healing Activation', '',
        `**Task:** ${ctx.slug}`, `**Step:** ${s.stepName}`,
        `**Timestamp:** ${new Date().toISOString()}`, '', '---', '',
        '## ❌ Failure Detected', '', `**Exit Code:** ${match[1]}`, '',
        '**Recent Output:**', '```', s.recentOutput.join('\n'), '```', '', '---', '',
        "## 🔧 Claude's Healing Process", '',
      ].join('\n'));
      return { ...s, selfHealingFile, recentOutput: [] };
    },
  },
  {
    pattern: /\[self-healing\].*Re-running/i,
    apply: (_ctx, s) => {
      if (!s.selfHealingFile) return s;
      appendFileSync(s.selfHealingFile, [
        '', "*(See full log for Claude's diagnostic process)*", '', '---', '',
        '## ✅ Resolution Applied', '',
        "The self-healing process completed. Check the full execution log to see Claude's analysis and fix.",
        '', '---', '', '*Auto-captured*', '',
      ].join('\n'));
      return { ...s, selfHealingFile: '' };
    },
  },
];

function onLogMessage(ctx: LogContext, s: LogState, level: string, text: string): LogState {
  appendLog(s.logFile, `[${level}] ${text}`);
  return LOG_MATCHERS.reduce<{ matched: boolean; state: LogState }>(
    ({ matched, state }, { pattern, apply }) => {
      if (matched) return { matched, state };
      const m = pattern.exec(text);
      return m ? { matched: true, state: apply(ctx, state, text, m) } : { matched, state };
    },
    { matched: false, state: s },
  ).state;
}

function onWorkflowComplete(ctx: LogContext, s: LogState): LogState {
  appendLog(s.logFile, `\n${'━'.repeat(51)}\nTask Complete: ${ctx.slug}\nFinished: ${new Date().toISOString()}\n${'━'.repeat(51)}\n`);

  const indexFile = join(ctx.highlightsDir, 'README.md');
  if (!existsSync(indexFile)) {
    writeFileSync(indexFile, [
      '# Execution Highlights', '',
      'This directory contains automatically extracted highlight moments from task executions.',
      '', '## Latest Highlights', '',
    ].join('\n'));
  }
  const highlights = (readdirSync(ctx.highlightsDir) as string[])
    .filter((f) => f.startsWith(ctx.ts) && f.endsWith('.md'))
    .sort();
  if (highlights.length > 0) {
    const entries = highlights.map((f) => `- [${f.replace(/\.md$/, '')}](./${f})`).join('\n');
    appendFileSync(indexFile, `\n### ${ctx.slug} (${new Date().toISOString()})\n${entries}\n`);
  }

  return s;
}

function onOutputText(s: LogState, text: string): LogState {
  appendLog(s.logFile, text);
  return { ...s, recentOutput: [...s.recentOutput, text] };
}

// ============================================================================
// Reducer — routes each event to its handler
// ============================================================================

function reduce(ctx: LogContext, s: LogState, event: Event): LogState {
  switch (event.type) {
    case 'workflow:start':    return onWorkflowStart(ctx, s);
    case 'step:start':        return onStepStart(ctx, s, event.index, event.name);
    case 'step:complete':     return onStepComplete(s);
    case 'step:error':        return onStepError(s, event.error);
    case 'output:text':       return onOutputText(s, event.text);
    case 'output:tool':       return onTool(ctx, s, event.tool, event.input);
    case 'log':               return onLogMessage(ctx, s, event.level, event.text);
    case 'workflow:complete': return onWorkflowComplete(ctx, s);
    default:                  return s;
  }
}

// ============================================================================
// Public API
// ============================================================================

export interface Logger {
  observe(event: Event): void;
  getHighlightsDir(): string;
  getTimestamp(): string;
}

export function createLogger(logDir: string, taskName: string): Logger {
  const ctx: LogContext = {
    logDir,
    highlightsDir: join(logDir, 'highlights'),
    ts: formatTimestamp(new Date()),
    slug: slugify(taskName, 40) || 'task',
  };
  const enabled = process.env['EXECUTANT_LOG'] !== '0';
  let state = INIT_STATE;

  return {
    getHighlightsDir: () => ctx.highlightsDir,
    getTimestamp: () => ctx.ts,
    observe(event: Event): void {
      if (!enabled) return;
      try { state = reduce(ctx, state, event); }
      catch (err) { console.warn(`[logger] error: ${getErrorMessage(err)}`); }
    },
  };
}

// ============================================================================
// Event stream tee
// ============================================================================

export async function* withLogger(
  gen: AsyncGenerator<Event>,
  logger: Logger,
): AsyncGenerator<Event> {
  for await (const event of gen) {
    logger.observe(event);
    yield event;
  }
}
