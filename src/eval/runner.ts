import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { runClaude } from '../tasks/claude.js';
import { stripPromptHeader } from '../lib/utils.js';

/**
 * Substitutes {{PLACEHOLDER}} tokens in a template string with resolved values.
 */
export function substituteVars(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, v),
    template,
  );
}

/**
 * Runs a prompt template with substituted vars through Claude (no tools).
 * Returns the full text output as a string.
 */
export async function runPrompt(templatePath: string, vars: Record<string, string>): Promise<string> {
  const template = stripPromptHeader(readFileSync(templatePath, 'utf8'));
  const prompt = substituteVars(template, vars);

  const lines: string[] = [];
  for await (const event of runClaude({
    type: 'claude',
    name: `eval:${basename(templatePath, '.txt')}`,
    prompt,
    allowedTools: [],
    permissionMode: 'default',
  })) {
    if (event.type === 'output:text') lines.push(event.text);
  }

  return lines.join('');
}
