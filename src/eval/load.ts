import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import type { EvalFile, EvalTestCase } from './types.js';

const EvalTestCaseSchema = z.object({
  id: z.string(),
  vars: z.record(z.string()),
  criteria: z.array(z.string()).min(1),
});

const EvalFileSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  placeholders: z.array(z.string()).default([]),
  test_cases: z.array(EvalTestCaseSchema).min(1),
});

/**
 * Resolves a var value: if it looks like a path relative to evalDir that exists,
 * returns the file contents. Otherwise returns the value as-is.
 */
function resolveVarValue(value: string, evalDir: string, key: string): string {
  // Values without '/' or '.' can't be file paths — skip resolution
  if (!value.includes('/') && !value.includes('.')) return value;
  const candidate = isAbsolute(value) ? value : join(evalDir, value);
  if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  // Also try relative to CWD (repo root)
  const fromCwd = resolve(value);
  if (existsSync(fromCwd)) return readFileSync(fromCwd, 'utf8');
  // Warn: value looks like a path but no file was found — likely a misconfigured fixture
  if (value.includes('/')) {
    console.warn(`[eval] warning: var "${key}" looks like a file path but was not found: ${value}`);
  }
  return value;
}

/**
 * Loads and validates an eval YAML file.
 * Resolves prompt path and fixture file contents relative to the eval file's directory.
 */
export function loadEvalFile(filePath: string): EvalFile {
  const absPath = resolve(filePath);
  const evalDir = dirname(absPath);
  const raw = readFileSync(absPath, 'utf8');
  const doc = EvalFileSchema.parse(parseYaml(raw));

  // Resolve prompt path: absolute → as-is; relative → try CWD first, then eval dir
  const promptPath = isAbsolute(doc.prompt)
    ? doc.prompt
    : existsSync(resolve(doc.prompt))
      ? resolve(doc.prompt)
      : resolve(evalDir, doc.prompt);
  if (!existsSync(promptPath)) {
    throw new Error(`Eval "${doc.name}": prompt file not found: ${doc.prompt} (tried CWD and eval file directory)`);
  }

  const testCases: EvalTestCase[] = doc.test_cases.map((tc) => ({
    id: tc.id,
    vars: Object.fromEntries(
      Object.entries(tc.vars).map(([k, v]) => [k, resolveVarValue(v, evalDir, k)]),
    ),
    criteria: tc.criteria,
  }));

  // Validate all declared placeholders have corresponding vars in every test case
  for (const tc of testCases) {
    for (const placeholder of doc.placeholders) {
      if (!(placeholder in tc.vars)) {
        throw new Error(
          `Eval "${doc.name}", case "${tc.id}": missing var for placeholder "{{${placeholder}}}"`,
        );
      }
    }
  }

  return {
    name: doc.name,
    prompt: promptPath,
    placeholders: doc.placeholders,
    testCases,
  };
}
