// ============================================================================
// SELF-IMPROVEMENT RETROSPECTIVE
// ============================================================================
// After a workflow with `self_improve: true` completes, this module:
//   1. Reads highlight files written by the Logger for the current run
//   2. Calls Claude with the retrospective-analysis prompt
//   3. Parses the IMPROVED_YAML and CHANGELOG sections from the response
//   4. Saves improved task to tasks/backlog/{timestamp}-{name}-improved.yaml
//   5. Saves changelog to tasks/backlog/{timestamp}-{name}-changelog.md
//
// Non-blocking: all errors are caught and logged; the workflow still completes.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import type { Workflow } from './types.js';
import { findExecutantLocalDir } from './logger.js';
import { slugify, formatTimestamp } from './lib/utils.js';

const RetrospectiveOutputSchema = z.object({
  improved_yaml: z.string(),
  changelog: z.string(),
});

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts');
const RETROSPECTIVE_PROMPT = readFileSync(join(PROMPTS_DIR, 'retrospective-analysis.txt'), 'utf8');

// ============================================================================
// Public API
// ============================================================================

/**
 * Runs retrospective analysis on the completed workflow.
 * Reads highlights from the Logger's highlights directory, calls Claude to
 * generate an improved task YAML, and saves both files to tasks/backlog/.
 *
 * Always resolves — never throws.
 */
export async function runRetrospective(
  workflowFilePath: string,
  workflow: Workflow,
  highlightsDir: string,
  runTimestamp: string,
): Promise<void> {
  try {
    await doRetrospective(workflowFilePath, workflow, highlightsDir, runTimestamp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`\nSelf-improvement: retrospective failed: ${msg}`);
  }
}

// ============================================================================
// Implementation
// ============================================================================

async function doRetrospective(
  workflowFilePath: string,
  workflow: Workflow,
  highlightsDir: string,
  runTimestamp: string,
): Promise<void> {
  if (!existsSync(highlightsDir)) {
    console.log('\nSelf-improvement: no highlights directory found, skipping.');
    return;
  }

  const allFiles = readdirSync(highlightsDir) as string[];
  const runHighlights = allFiles
    .filter((f) => f.startsWith(runTimestamp) && f.endsWith('.md'))
    .sort();

  if (runHighlights.length === 0) {
    console.log('\nSelf-improvement: no highlights for this run — task completed without issues, skipping.');
    return;
  }

  const divider = '━'.repeat(51);
  console.log(`\n${divider}`);
  console.log('Self-Improvement: Analyzing execution and generating improvements...');
  console.log(`${divider}\n`);
  console.log(`Found ${runHighlights.length} highlight(s) to analyze`);

  // Build metrics summary
  const countByPattern = (pat: string) => runHighlights.filter((f) => f.includes(pat)).length;
  const judgeFailures = countByPattern('_judge_FAIL');
  const selfHealingCount = countByPattern('_self_healing');
  const complexSequences = countByPattern('_complex_sequence');

  const metrics = [
    `- Judge Failures: ${judgeFailures}`,
    `- Self-Healing Activations: ${selfHealingCount}`,
    `- Complex Tool Sequences: ${complexSequences}`,
    `- Total Highlights: ${runHighlights.length}`,
  ].join('\n');

  console.log(`\nExecution Metrics:\n${metrics}\n`);
  console.log('Analyzing execution and generating improvements...\n');

  // Read highlight file contents
  const highlightContents = runHighlights
    .map((f) => {
      const content = readFileSync(join(highlightsDir, f), 'utf8');
      return `### ${f}\n\n${content}`;
    })
    .join('\n\n---\n\n');

  // Read original YAML
  const originalYaml = readFileSync(workflowFilePath, 'utf8');
  const taskName = basename(workflowFilePath, '.yaml');

  // Build prompt from template
  const prompt = RETROSPECTIVE_PROMPT
    .replaceAll('{{TASK_NAME}}', taskName)
    .replaceAll('{{ORIGINAL_GOAL}}', workflow.goal)
    .replaceAll('{{ORIGINAL_YAML}}', originalYaml)
    .replaceAll('{{HIGHLIGHTS}}', highlightContents)
    .replaceAll('{{METRICS}}', metrics);

  // Call Claude — no filesystem tools needed, all context is in the prompt
  const result = spawnSync(
    'claude',
    [
      '-p', prompt,
      '--allowedTools', 'Read',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'text',
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );

  if (result.error) {
    console.warn(`Self-improvement: failed to run claude: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ?? '';
    console.warn(`Self-improvement: claude exited with code ${result.status}${stderr ? ': ' + stderr : ''}`);
    return;
  }

  const response = result.stdout ?? '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(response));
  } catch {
    console.warn(`Self-improvement: could not parse Claude response as JSON.\nResponse: ${response.trim()}`);
    return;
  }
  const zodResult = RetrospectiveOutputSchema.safeParse(parsed);
  if (!zodResult.success) {
    console.warn('Self-improvement: response schema mismatch — improved YAML not saved.');
    return;
  }
  const improvedYaml = zodResult.data.improved_yaml.trim();
  const changelog = zodResult.data.changelog.trim() || 'No changelog generated.';

  // Validate YAML before saving
  try {
    parseYaml(improvedYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Self-improvement: generated YAML is invalid (${msg}), skipping save.`);
    return;
  }

  // Resolve backlog directory
  const startDir = dirname(resolve(workflowFilePath));
  const executantLocal = findExecutantLocalDir(startDir);
  const backlogDir = executantLocal
    ? join(executantLocal, 'tasks', 'backlog')
    : join(startDir, '..', 'backlog');
  mkdirSync(backlogDir, { recursive: true });

  // Generate output filenames
  const ts = formatTimestamp(new Date());
  const slug = slugify(taskName, 40);
  const improvedFile = join(backlogDir, `${ts}-${slug}-improved.yaml`);
  const changelogFile = join(backlogDir, `${ts}-${slug}-changelog.md`);

  writeFileSync(improvedFile, improvedYaml + '\n', 'utf8');
  writeFileSync(changelogFile, changelog + '\n', 'utf8');

  console.log(`✅ Improved task saved: ${improvedFile}`);
  console.log(`✅ Changelog saved: ${changelogFile}`);

  console.log(`\n${divider}`);
  console.log('Improvement Summary');
  console.log(`${divider}\n`);
  console.log(changelog);
}

// ============================================================================
// Helpers
// ============================================================================

export function stripFences(text: string): string {
  return text
    .replace(/^```\w*\s*\n?/im, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
}

/** Extracts the outermost JSON object from text, ignoring surrounding prose or fences. */
export function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object found in response');
  return text.slice(start, end + 1);
}

