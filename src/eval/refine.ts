import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { stripPromptHeader } from '../lib/utils.js';
import { runClaudeStructured } from '../tasks/claude.js';
import type { FailureContext } from './types.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROMPT_REFINER = stripPromptHeader(
  readFileSync(join(__dir, 'prompts', 'prompt-refiner.txt'), 'utf8'),
);

function formatFailures(failures: FailureContext[]): string {
  return failures.map((f) => {
    const varsSummary = Object.entries(f.vars)
      .map(([k, v]) => {
        const preview = v.length > 300 ? v.slice(0, 300) + '\n... (truncated)' : v;
        return `  ${k}:\n${preview.split('\n').map(line => `    ${line}`).join('\n')}`;
      })
      .join('\n');

    const outputPreview = f.output.length > 1500
      ? f.output.slice(0, 1500) + '\n... (truncated)'
      : f.output;

    const failedList = f.failedCriteria
      .map((c) => `  - "${c.criterion}"\n    Reason: ${c.reason}`)
      .join('\n');

    return [
      `Test case: ${f.caseId}`,
      `Input vars:\n${varsSummary}`,
      `Output:\n${outputPreview.split('\n').map(line => `  ${line}`).join('\n')}`,
      `Failed criteria:\n${failedList}`,
    ].join('\n\n');
  }).join('\n\n---\n\n');
}

const RefinedTemplateSchema = z.object({
  template: z.string().min(1),
});

/**
 * Runs a refinement agent that rewrites a prompt template to fix failures.
 * Returns the improved template text (without the doc header).
 */
export async function refinePrompt(
  templatePath: string,
  failures: FailureContext[],
): Promise<string> {
  const currentTemplate = stripPromptHeader(readFileSync(templatePath, 'utf8'));
  const prompt = PROMPT_REFINER
    .replaceAll('{{TEMPLATE}}', currentTemplate)
    .replaceAll('{{FAILURES}}', formatFailures(failures));

  const result = await runClaudeStructured(
    {
      type: 'claude',
      name: 'eval:prompt-refiner',
      prompt,
      allowedTools: [],
      permissionMode: 'default',
    },
    RefinedTemplateSchema,
  );

  let templateText = result.template.trim();
  // Guard against double-wrapping: Claude sometimes nests {"template":"..."} inside the field
  if (templateText.startsWith('{')) {
    try {
      const inner = JSON.parse(templateText) as unknown;
      if (inner && typeof inner === 'object' && 'template' in inner && typeof (inner as Record<string, unknown>)['template'] === 'string') {
        templateText = ((inner as Record<string, unknown>)['template'] as string).trim();
      }
    } catch { /* not JSON, use as-is */ }
  }
  return templateText;
}

/**
 * Writes an improved template to disk, preserving the original doc header.
 */
export function saveRefinedTemplate(templatePath: string, improvedBody: string): void {
  const original = readFileSync(templatePath, 'utf8');
  // Matches bash-style # comment block headers as defined in prompt guidelines
  const headerMatch = original.match(/^((?:#[^\n]*\n)+\n?)/);
  const header = headerMatch ? headerMatch[1] : '';
  // Strip any header the refiner accidentally included at the top of the body
  const body = improvedBody.replace(/^(#[^\n]*\n)+\n?/, '').trimStart();
  writeFileSync(templatePath, header + body + '\n', 'utf8');
}
