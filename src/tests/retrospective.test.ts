// ============================================================================
// RETROSPECTIVE TESTS
// ============================================================================
// Tests for the self-improvement retrospective module: stripFences helper
// and non-blocking early-return behaviour of runRetrospective.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stripFences, extractJson, runRetrospective } from '../retrospective.js';

// ----------------------------------------------------------------------------
// stripFences
// ----------------------------------------------------------------------------

describe('stripFences', () => {
  test('strips yaml-fenced block', () => {
    const result = stripFences('```yaml\ngoal: x\n```');
    assert.equal(result, 'goal: x');
  });

  test('strips yml-fenced block', () => {
    const result = stripFences('```yml\ngoal: x\n```');
    assert.equal(result, 'goal: x');
  });

  test('strips generic ``` fence', () => {
    const result = stripFences('```\ngoal: x\n```');
    assert.equal(result, 'goal: x');
  });

  test('returns plain text unchanged', () => {
    const result = stripFences('goal: x\nsteps: []');
    assert.equal(result, 'goal: x\nsteps: []');
  });

  test('trims surrounding whitespace', () => {
    const result = stripFences('  \ngoal: x\n  ');
    assert.equal(result, 'goal: x');
  });

  test('strips json-fenced block', () => {
    const result = stripFences('```json\n{"pass":true}\n```');
    assert.equal(result, '{"pass":true}');
  });
});

// ----------------------------------------------------------------------------
// extractJson
// ----------------------------------------------------------------------------

describe('extractJson', () => {
  test('extracts plain JSON object', () => {
    assert.equal(extractJson('{"a":1}'), '{"a":1}');
  });

  test('extracts JSON preceded by prose', () => {
    assert.equal(extractJson('Here is the result:\n{"a":1}'), '{"a":1}');
  });

  test('extracts JSON followed by prose', () => {
    assert.equal(extractJson('{"a":1}\nDone.'), '{"a":1}');
  });

  test('extracts JSON wrapped in markdown fences', () => {
    assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  });

  test('extracts JSON surrounded by prose and fences', () => {
    const input = 'Sure! Here you go:\n```json\n{"improved_yaml":"x","changelog":"y"}\n```\nHope that helps!';
    assert.equal(extractJson(input), '{"improved_yaml":"x","changelog":"y"}');
  });

  test('throws when no JSON object is present', () => {
    assert.throws(() => extractJson('no json here'), /no JSON object found/);
  });

  test('throws when braces are mismatched', () => {
    assert.throws(() => extractJson('{only open'), /no JSON object found/);
  });
});

// ----------------------------------------------------------------------------
// runRetrospective — non-blocking early returns
// ----------------------------------------------------------------------------

describe('runRetrospective', () => {
  const fakeWorkflow = { goal: 'test goal', tasks: [] };
  const fakeTimestamp = '20260101-120000';

  test('resolves without throwing when highlights dir does not exist', async () => {
    const nonExistentDir = join(tmpdir(), `retro-test-missing-${Date.now()}`);
    await assert.doesNotReject(() =>
      runRetrospective('/fake/workflow.yaml', fakeWorkflow, nonExistentDir, fakeTimestamp),
    );
  });

  test('resolves without throwing when highlights dir is empty', async () => {
    const emptyDir = join(tmpdir(), `retro-test-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    await assert.doesNotReject(() =>
      runRetrospective('/fake/workflow.yaml', fakeWorkflow, emptyDir, fakeTimestamp),
    );
  });

  test('resolves without throwing when no highlights match the run timestamp', async () => {
    const highlightsDir = join(tmpdir(), `retro-test-nomatch-${Date.now()}`);
    mkdirSync(highlightsDir, { recursive: true });
    // The timestamp in the highlight file doesn't match fakeTimestamp
    writeFileSync(join(highlightsDir, '19990101-000000_step1_judge_FAIL.md'), '# Judge\nFAIL');
    await assert.doesNotReject(() =>
      runRetrospective('/fake/workflow.yaml', fakeWorkflow, highlightsDir, fakeTimestamp),
    );
  });
});

// ----------------------------------------------------------------------------
// runRetrospective — happy path (mock Claude)
// ----------------------------------------------------------------------------

describe('runRetrospective — happy path (mock Claude)', () => {
  let originalPath: string;
  let tmpRoot: string;
  let workflowFile: string;
  let highlightsDir: string;
  const runTimestamp = '20260501-120000';
  const fakeWorkflow = { goal: 'original goal text', tasks: [] };

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `retro-happy-${Date.now()}`);
    const todoDir = join(tmpRoot, 'todo');
    mkdirSync(todoDir, { recursive: true });
    highlightsDir = join(tmpRoot, 'highlights');
    mkdirSync(highlightsDir, { recursive: true });

    workflowFile = join(todoDir, 'task.yaml');
    writeFileSync(workflowFile, 'goal: original goal text\nself_improve: true\nsteps: []\n', 'utf8');

    // One judge-fail and one self-healing highlight matching runTimestamp
    writeFileSync(
      join(highlightsDir, `${runTimestamp}_step1_judge_FAIL.md`),
      '# Judge FAIL\nOutput did not meet quality bar.',
      'utf8',
    );
    writeFileSync(
      join(highlightsDir, `${runTimestamp}_step2_self_healing.md`),
      '# Self-healing\nFixed missing dependency.',
      'utf8',
    );

    // Mock Claude: outputs valid JSON with improved YAML + changelog, exits 0.
    // Single-quoted echo keeps \n as literal backslash-n, which is valid JSON string escaping.
    const mockDir = join(tmpdir(), `retro-mock-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    writeFileSync(
      join(mockDir, 'claude'),
      [
        '#!/usr/bin/env bash',
        "echo '{\"improved_yaml\": \"goal: original goal text\\nself_improve: true\\nsteps: []\", \"changelog\": \"## Changes\\n- Improved prompt clarity\"}'",
        'exit 0',
      ].join('\n') + '\n',
      'utf8',
    );
    chmodSync(join(mockDir, 'claude'), 0o755);

    originalPath = process.env['PATH'] ?? '';
    process.env['PATH'] = `${mockDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
  });

  test('writes both improved YAML and changelog to tasks/backlog', async () => {
    await runRetrospective(workflowFile, fakeWorkflow, highlightsDir, runTimestamp);
    // backlogDir = dirname(workflowFile)/../backlog = tmpRoot/backlog
    const backlogDir = join(tmpRoot, 'backlog');
    const files = readdirSync(backlogDir);
    assert.ok(
      files.some((f) => f.endsWith('-improved.yaml')),
      `Expected -improved.yaml in backlog. Got: ${files.join(', ')}`,
    );
    assert.ok(
      files.some((f) => f.endsWith('-changelog.md')),
      `Expected -changelog.md in backlog. Got: ${files.join(', ')}`,
    );
  });

  test('improved YAML preserves original goal and self_improve: true', async () => {
    await runRetrospective(workflowFile, fakeWorkflow, highlightsDir, runTimestamp);
    const backlogDir = join(tmpRoot, 'backlog');
    const improvedFile = readdirSync(backlogDir).find((f) => f.endsWith('-improved.yaml'));
    assert.ok(improvedFile, 'No improved YAML file found in backlog');
    const content = readFileSync(join(backlogDir, improvedFile!), 'utf8');
    assert.ok(
      content.includes('goal: original goal text'),
      `Expected goal preserved in improved YAML. Got:\n${content}`,
    );
    assert.ok(
      content.includes('self_improve: true'),
      `Expected self_improve: true in improved YAML. Got:\n${content}`,
    );
  });

  test('changelog file is written with non-empty content', async () => {
    await runRetrospective(workflowFile, fakeWorkflow, highlightsDir, runTimestamp);
    const backlogDir = join(tmpRoot, 'backlog');
    const changelogFile = readdirSync(backlogDir).find((f) => f.endsWith('-changelog.md'));
    assert.ok(changelogFile, 'No changelog file found in backlog');
    const content = readFileSync(join(backlogDir, changelogFile!), 'utf8');
    assert.ok(content.trim().length > 0, 'Changelog should not be empty');
  });
});

// ----------------------------------------------------------------------------
// runRetrospective — non-blocking failures
// ----------------------------------------------------------------------------

describe('runRetrospective — non-blocking when Claude fails', () => {
  let originalPath: string;
  let tmpRoot: string;
  let workflowFile: string;
  let highlightsDir: string;
  const runTimestamp = '20260501-130000';
  const fakeWorkflow = { goal: 'test goal', tasks: [] };

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `retro-nonblock-${Date.now()}`);
    const todoDir = join(tmpRoot, 'todo');
    mkdirSync(todoDir, { recursive: true });
    highlightsDir = join(tmpRoot, 'highlights');
    mkdirSync(highlightsDir, { recursive: true });

    workflowFile = join(todoDir, 'task.yaml');
    writeFileSync(workflowFile, 'goal: test goal\nself_improve: true\nsteps: []\n', 'utf8');
    // Highlight present so execution reaches the Claude call
    writeFileSync(
      join(highlightsDir, `${runTimestamp}_step1_judge_FAIL.md`),
      '# Judge FAIL\nFail.',
      'utf8',
    );

    originalPath = process.env['PATH'] ?? '';
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
  });

  test('resolves without throwing when Claude exits non-zero', async () => {
    const mockDir = join(tmpdir(), `retro-exit1-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    writeFileSync(join(mockDir, 'claude'), '#!/usr/bin/env bash\nexit 1\n', 'utf8');
    chmodSync(join(mockDir, 'claude'), 0o755);
    process.env['PATH'] = `${mockDir}:${originalPath}`;

    await assert.doesNotReject(() =>
      runRetrospective(workflowFile, fakeWorkflow, highlightsDir, runTimestamp),
    );
  });

  test('resolves without throwing when Claude returns unparseable output', async () => {
    const mockDir = join(tmpdir(), `retro-badjson-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    writeFileSync(
      join(mockDir, 'claude'),
      '#!/usr/bin/env bash\necho "not valid json at all"\nexit 0\n',
      'utf8',
    );
    chmodSync(join(mockDir, 'claude'), 0o755);
    process.env['PATH'] = `${mockDir}:${originalPath}`;

    await assert.doesNotReject(() =>
      runRetrospective(workflowFile, fakeWorkflow, highlightsDir, runTimestamp),
    );
  });

  test('resolves without throwing when Claude returns schema-invalid JSON', async () => {
    const mockDir = join(tmpdir(), `retro-badschema-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    writeFileSync(
      join(mockDir, 'claude'),
      "#!/usr/bin/env bash\necho '{\"unexpected_field\": \"value\"}'\nexit 0\n",
      'utf8',
    );
    chmodSync(join(mockDir, 'claude'), 0o755);
    process.env['PATH'] = `${mockDir}:${originalPath}`;

    await assert.doesNotReject(() =>
      runRetrospective(workflowFile, fakeWorkflow, highlightsDir, runTimestamp),
    );
  });
});
