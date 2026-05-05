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
import { slugify, formatTimestamp } from './lib/utils.js';

// ============================================================================
// Helpers
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

// ============================================================================
// Log directory resolution
// ============================================================================

/**
 * Walks up from startDir looking for `.claude/executant.local/`.
 * Returns the executant.local path if found, otherwise null.
 */
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

/**
 * Given a workflow file path, returns the log directory:
 *   .claude/executant.local/logs/
 *
 * If the file is not inside an executant project, falls back to a `logs/`
 * directory next to the workflow file.
 */
export function resolveLogDir(workflowFilePath: string): string {
  const startDir = dirname(resolve(workflowFilePath));
  const executantLocal = findExecutantLocalDir(startDir);
  if (executantLocal) return join(executantLocal, 'logs');
  return join(startDir, 'logs');
}

// ============================================================================
// Logger class
// ============================================================================

export class Logger {

  private readonly enabled: boolean;
  private readonly logDir: string;
  private readonly highlightsDir: string;
  private readonly timestamp: string;
  private readonly taskName: string;

  private logFile: string = '';

  // Per-step state
  private stepIndex: number = -1;
  private stepName: string = '';
  private stepStartMs: number = 0;
  private toolCount: number = 0;
  private complexSequenceFile: string = '';
  private selfHealingFile: string = '';
  private judgeAttempt: number = 0;
  private recentOutput: string[] = [];

  constructor(logDir: string, taskName: string) {
    this.enabled = process.env['EXECUTANT_LOG'] !== '0';
    this.logDir = logDir;
    this.highlightsDir = join(logDir, 'highlights');
    this.timestamp = formatTimestamp(new Date());
    this.taskName = slugify(taskName, 40) || 'task';
  }

  getHighlightsDir(): string { return this.highlightsDir; }
  getTimestamp(): string { return this.timestamp; }

  /** Feed each event from the runner into the logger. */
  observe(event: Event): void {
    if (!this.enabled) return;
    try {
      this.dispatch(event);
    } catch (err) {
      // Logging must never crash the workflow, but surface the failure.
      console.warn(`[logger] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Event dispatch
  // --------------------------------------------------------------------------

  private dispatch(event: Event): void {
    switch (event.type) {
      case 'workflow:start':
        this.initDirs();
        break;
      case 'step:start':
        this.onStepStart(event.index, event.name);
        break;
      case 'step:complete':
        this.onStepComplete();
        break;
      case 'step:error':
        this.onStepError(event.error);
        break;
      case 'output:text':
        this.appendLog(event.text);
        this.recentOutput.push(event.text);
        break;
      case 'output:tool':
        this.onTool(event.tool, event.input);
        break;
      case 'log':
        this.onLogMessage(event.level, event.text);
        break;
      case 'workflow:complete':
        this.onWorkflowComplete();
        break;
      // step:skip / step:iteration / output:cost — no specific action needed
    }
  }

  // --------------------------------------------------------------------------
  // Initialisation
  // --------------------------------------------------------------------------

  private initDirs(): void {
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(this.highlightsDir, { recursive: true });
    this.logFile = join(this.logDir, `${this.timestamp}_${this.taskName}.log`);
    writeFileSync(
      this.logFile,
      `# Execution Log\nTask: ${this.taskName}\nStarted: ${new Date().toISOString()}\n${'━'.repeat(51)}\n\n`,
    );
  }

  // --------------------------------------------------------------------------
  // Step lifecycle
  // --------------------------------------------------------------------------

  private onStepStart(index: number, name: string): void {
    Object.assign(this, {
      stepIndex: index,
      stepName: name,
      stepStartMs: Date.now(),
      toolCount: 0,
      complexSequenceFile: '',
      selfHealingFile: '',
      judgeAttempt: 0,
      recentOutput: [],
    });
    this.appendLog(
      `\n${'━'.repeat(51)}\nStep ${index + 1}: ${name}\nStarted: ${new Date().toISOString()}\n${'━'.repeat(51)}\n`,
    );
  }

  private onStepComplete(): void {
    const durS = ((Date.now() - this.stepStartMs) / 1000).toFixed(1);
    this.appendLog(`\nStep completed in ${durS}s\n`);
    this.finalizeComplexSequence();
  }

  private onStepError(error: Error): void {
    this.appendLog(`\nStep failed: ${error.message}\n`);
    this.finalizeComplexSequence();
  }

  // --------------------------------------------------------------------------
  // Tool calls → complex sequence highlights
  // --------------------------------------------------------------------------

  private onTool(tool: string, input: Record<string, unknown>): void {
    const desc = toolSummary(tool, input);
    this.appendLog(`   [${tool}] ${desc}`);

    this.toolCount++;

    if (this.toolCount === 3) {
      // Create the complex-sequence highlight file on the third tool call.
      this.complexSequenceFile = join(
        this.highlightsDir,
        `${this.timestamp}_step${this.stepIndex + 1}_complex_sequence.md`,
      );
      writeFileSync(
        this.complexSequenceFile,
        [
          '# Complex Tool Sequence',
          '',
          `**Task:** ${this.taskName}`,
          `**Step:** ${this.stepName}`,
          `**Timestamp:** ${new Date().toISOString()}`,
          '',
          '---',
          '',
          "## Claude's Tool Orchestration",
          '',
          'Claude used multiple tools to complete this step:',
          '',
        ].join('\n'),
      );
    }

    if (this.toolCount >= 3 && this.complexSequenceFile) {
      appendFileSync(this.complexSequenceFile, `${this.toolCount}. **${tool}** - ${desc}\n`);
    }
  }

  private finalizeComplexSequence(): void {
    if (this.toolCount >= 3 && this.complexSequenceFile) {
      appendFileSync(
        this.complexSequenceFile,
        `\n---\n\n*Total tools used: ${this.toolCount}*\n\n*Captured by Executant Logger*\n`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Log events → judge / self-healing highlights
  // --------------------------------------------------------------------------

  private onLogMessage(level: string, text: string): void {
    this.appendLog(`[${level}] ${text}`);

    // Judge PASS
    if (/\[judge\]\s+PASS/i.test(text)) {
      this.judgeAttempt++;
      this.saveJudgeHighlight('PASS', text);
      return;
    }

    // Judge FAIL
    if (/\[judge\]\s+FAIL/i.test(text)) {
      this.judgeAttempt++;
      this.saveJudgeHighlight('FAIL', text);
      return;
    }

    // Self-healing start (multi-pass: "[self-healing] Attempt X/Y failed (exit N)")
    const healingMatch = text.match(/\[self-healing\].*failed.*exit\s+(\d+)/i);
    if (healingMatch) {
      this.startSelfHealingHighlight(healingMatch[1]);
      return;
    }

    // Self-healing complete (re-running after fix)
    if (/\[self-healing\].*Re-running/i.test(text)) {
      this.completeSelfHealingHighlight();
    }
  }

  // --------------------------------------------------------------------------
  // Highlight writers
  // --------------------------------------------------------------------------

  private saveJudgeHighlight(verdict: 'PASS' | 'FAIL', output: string): void {
    const file = join(
      this.highlightsDir,
      `${this.timestamp}_step${this.stepIndex + 1}_judge_${verdict}.md`,
    );
    writeFileSync(
      file,
      [
        `# Judge Verdict: ${verdict}`,
        '',
        `**Task:** ${this.taskName}`,
        `**Step:** ${this.stepName}`,
        `**Attempt:** ${this.judgeAttempt}`,
        `**Timestamp:** ${new Date().toISOString()}`,
        '',
        '---',
        '',
        output,
        '',
        '---',
        '',
        '*Auto-captured*',
        '',
      ].join('\n'),
    );
  }

  private startSelfHealingHighlight(exitCode: string): void {
    this.selfHealingFile = join(
      this.highlightsDir,
      `${this.timestamp}_step${this.stepIndex + 1}_self_healing.md`,
    );
    const errorOutput = this.recentOutput.join('\n');
    this.recentOutput = [];
    writeFileSync(
      this.selfHealingFile,
      [
        '# Self-Healing Activation',
        '',
        `**Task:** ${this.taskName}`,
        `**Step:** ${this.stepName}`,
        `**Timestamp:** ${new Date().toISOString()}`,
        '',
        '---',
        '',
        '## ❌ Failure Detected',
        '',
        `**Exit Code:** ${exitCode}`,
        '',
        '**Recent Output:**',
        '```',
        errorOutput,
        '```',
        '',
        '---',
        '',
        "## 🔧 Claude's Healing Process",
        '',
      ].join('\n'),
    );
  }

  private completeSelfHealingHighlight(): void {
    if (!this.selfHealingFile) return;
    appendFileSync(
      this.selfHealingFile,
      [
        '',
        "*(See full log for Claude's diagnostic process)*",
        '',
        '---',
        '',
        '## ✅ Resolution Applied',
        '',
        "The self-healing process completed. Check the full execution log to see Claude's analysis and fix.",
        '',
        '---',
        '',
        '*Auto-captured*',
        '',
      ].join('\n'),
    );
    this.selfHealingFile = '';
  }

  // --------------------------------------------------------------------------
  // Workflow complete → index
  // --------------------------------------------------------------------------

  private onWorkflowComplete(): void {
    this.appendLog(
      `\n${'━'.repeat(51)}\nTask Complete: ${this.taskName}\nFinished: ${new Date().toISOString()}\n${'━'.repeat(51)}\n`,
    );
    this.writeHighlightsIndex();
  }

  private writeHighlightsIndex(): void {
    const indexFile = join(this.highlightsDir, 'README.md');

    if (!existsSync(indexFile)) {
      writeFileSync(
        indexFile,
        [
          '# Execution Highlights',
          '',
          'This directory contains automatically extracted highlight moments from task executions.',
          '',
          '## Latest Highlights',
          '',
        ].join('\n'),
      );
    }

    const files = readdirSync(this.highlightsDir) as string[];
    const taskHighlights = files
      .filter((f) => f.startsWith(this.timestamp) && f.endsWith('.md'))
      .sort();

    if (taskHighlights.length > 0) {
      const entries = taskHighlights.map((f) => `- [${f.replace(/\.md$/, '')}](./${f})`).join('\n');
      appendFileSync(indexFile, `\n### ${this.taskName} (${new Date().toISOString()})\n${entries}\n`);
    }
  }

  // --------------------------------------------------------------------------
  // Log file writes
  // --------------------------------------------------------------------------

  private appendLog(text: string): void {
    if (!this.logFile) return;
    appendFileSync(this.logFile, text + '\n');
  }
}

// ============================================================================
// Event stream tee
// ============================================================================

/**
 * Wraps an event generator so every event is also passed to the Logger.
 * The Logger is a transparent observer — it does not alter the event stream.
 */
export async function* withLogger(
  gen: AsyncGenerator<Event>,
  logger: Logger,
): AsyncGenerator<Event> {
  for await (const event of gen) {
    logger.observe(event);
    yield event;
  }
}
