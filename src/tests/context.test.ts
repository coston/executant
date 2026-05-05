// ============================================================================
// CONTEXT INJECTION TESTS
// ============================================================================
// Verifies that `context:` in a YAML step resolves var names → file paths,
// and that the runner prepends the file contents to the prompt.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWorkflow } from '../load-workflow.js';
import type { ClaudeTask } from '../types.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function tmpDir(): string {
  const dir = join(tmpdir(), `executant-ctx-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function tmpYaml(dir: string, content: string): string {
  return writeFile(dir, `${Date.now()}.yaml`, content);
}

// ----------------------------------------------------------------------------
// load-workflow: context var resolution
// ----------------------------------------------------------------------------

describe('loadWorkflow — context', () => {
  test('resolves context var names to file paths in ClaudeTask', () => {
    const dir = tmpDir();
    const filePath = writeFile(dir, 'notes.txt', 'hello from file');

    const yaml = tmpYaml(dir, `
goal: test
vars:
  my_file: "${filePath}"
steps:
  - name: analyze
    context: [my_file]
    prompt: |
      Now analyze the above.
`);

    const wf = loadWorkflow(yaml);
    const task = wf.tasks[0] as ClaudeTask;

    assert.equal(task.type, 'claude');
    assert.deepEqual(task.contextFiles, [filePath]);
  });

  test('resolves multiple context vars', () => {
    const dir = tmpDir();
    const fileA = writeFile(dir, 'a.txt', 'aaa');
    const fileB = writeFile(dir, 'b.txt', 'bbb');

    const yaml = tmpYaml(dir, `
goal: test
vars:
  file_a: "${fileA}"
  file_b: "${fileB}"
steps:
  - name: compare
    context: [file_a, file_b]
    prompt: Compare the above files.
`);

    const wf = loadWorkflow(yaml);
    const task = wf.tasks[0] as ClaudeTask;
    assert.deepEqual(task.contextFiles, [fileA, fileB]);
  });

  test('contextFiles is absent when context is not set', () => {
    const dir = tmpDir();
    const yaml = tmpYaml(dir, `
goal: test
steps:
  - name: no-context
    prompt: Just do something.
`);

    const wf = loadWorkflow(yaml);
    const task = wf.tasks[0] as ClaudeTask;
    assert.equal(task.contextFiles, undefined);
  });

  test('throws when context references an undefined var', () => {
    const dir = tmpDir();
    const yaml = tmpYaml(dir, `
goal: test
steps:
  - name: bad
    context: [missing_var]
    prompt: Analyze.
`);

    assert.throws(
      () => loadWorkflow(yaml),
      (err: Error) => {
        assert.ok(err.message.includes('missing_var'), `expected "missing_var" in: ${err.message}`);
        assert.ok(err.message.includes('"bad"'), `expected step name in: ${err.message}`);
        return true;
      },
    );
  });
});

// ----------------------------------------------------------------------------
// expandContext: file contents prepended to prompt
// ----------------------------------------------------------------------------

describe('context injection — prompt expansion', () => {
  test('file contents are prepended inside a labelled fence', async () => {
    const { expandContext } = await import('../runner.js');
    const dir = tmpDir();
    const ctxFile = writeFile(dir, 'spec.txt', 'KNOWN_CONTENT');

    const task = {
      type: 'claude' as const,
      name: 'step',
      prompt: 'ORIGINAL_PROMPT',
      contextFiles: [ctxFile],
    };

    const expanded = expandContext(task);

    assert.ok(
      expanded.prompt.includes('KNOWN_CONTENT'),
      'expanded prompt must contain file contents',
    );
    assert.ok(
      expanded.prompt.includes(`### ${ctxFile}`),
      'expanded prompt must include labelled fence header',
    );
    assert.ok(
      expanded.prompt.includes('ORIGINAL_PROMPT'),
      'expanded prompt must retain original prompt text',
    );
    // File contents must appear before the original prompt
    assert.ok(
      expanded.prompt.indexOf('KNOWN_CONTENT') < expanded.prompt.indexOf('ORIGINAL_PROMPT'),
      'file contents must precede the original prompt',
    );
  });

  test('multiple context files are each wrapped in labelled fences', async () => {
    const { expandContext } = await import('../runner.js');
    const dir = tmpDir();
    const fileA = writeFile(dir, 'a.txt', 'CONTENT_A');
    const fileB = writeFile(dir, 'b.txt', 'CONTENT_B');

    const task = {
      type: 'claude' as const,
      name: 'step',
      prompt: 'BASE_PROMPT',
      contextFiles: [fileA, fileB],
    };

    const expanded = expandContext(task);

    assert.ok(expanded.prompt.includes(`### ${fileA}`), 'must include header for file A');
    assert.ok(expanded.prompt.includes('CONTENT_A'), 'must include contents of file A');
    assert.ok(expanded.prompt.includes(`### ${fileB}`), 'must include header for file B');
    assert.ok(expanded.prompt.includes('CONTENT_B'), 'must include contents of file B');
    assert.ok(expanded.prompt.includes('BASE_PROMPT'), 'must retain original prompt');
    // Both files must appear before the base prompt
    assert.ok(expanded.prompt.indexOf('CONTENT_B') < expanded.prompt.indexOf('BASE_PROMPT'));
  });

  test('returns task unchanged when contextFiles is empty', async () => {
    const { expandContext } = await import('../runner.js');

    const task = {
      type: 'claude' as const,
      name: 'step',
      prompt: 'NO_CONTEXT_PROMPT',
      contextFiles: [],
    };

    const expanded = expandContext(task);
    assert.equal(expanded.prompt, 'NO_CONTEXT_PROMPT');
    assert.equal(expanded, task); // same reference — no copy made
  });

  test('returns task unchanged when contextFiles is absent', async () => {
    const { expandContext } = await import('../runner.js');

    const task = {
      type: 'claude' as const,
      name: 'step',
      prompt: 'NO_CONTEXT_PROMPT',
    };

    const expanded = expandContext(task);
    assert.equal(expanded.prompt, 'NO_CONTEXT_PROMPT');
    assert.equal(expanded, task);
  });

  test('throws a descriptive error when a context file cannot be read', async () => {
    const { expandContext } = await import('../runner.js');
    const dir = tmpDir();
    const nonExistent = join(dir, 'does-not-exist.txt');

    const task = {
      type: 'claude' as const,
      name: 'step',
      prompt: 'Analyze.',
      contextFiles: [nonExistent],
    };

    assert.throws(
      () => expandContext(task),
      (err: Error) => {
        assert.ok(
          err.message.includes('could not be read'),
          `Expected "could not be read" in: ${err.message}`,
        );
        assert.ok(
          err.message.includes('does-not-exist'),
          `Expected file name in: ${err.message}`,
        );
        return true;
      },
    );
  });
});
