// ============================================================================
// EVAL SYSTEM TESTS
// ============================================================================
// Tests for the internal eval dev tooling: loadEvalFile, substituteVars,
// runPrompt, judgeOutput, refinePrompt.
//
// All Claude calls use mock claude binaries installed into PATH — no real
// Claude invocations or API calls occur in this test suite.

import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { writeFileSync, mkdirSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

const _cleanupDirs: string[] = [];

afterEach(() => {
  for (const d of _cleanupDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = join(tmpdir(), `eval-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  _cleanupDirs.push(dir);
  return dir;
}

function installMockClaude(responseText: string): { mockDir: string; originalPath: string } {
  const mockDir = tmpDir();
  const responseFile = join(mockDir, 'response.ndjson');
  const assistantLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: responseText }] },
  });
  const resultLine = JSON.stringify({ type: 'result', total_cost_usd: 0.001 });
  writeFileSync(responseFile, `${assistantLine}\n${resultLine}\n`, 'utf8');

  const mockScript = join(mockDir, 'claude');
  writeFileSync(mockScript, `#!/usr/bin/env bash\ncat "${responseFile}"\nexit 0\n`, 'utf8');
  chmodSync(mockScript, 0o755);

  const originalPath = process.env['PATH'] ?? '';
  process.env['PATH'] = `${mockDir}:${originalPath}`;
  return { mockDir, originalPath };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('parses eval file as first positional arg', async () => {
    const { parseArgs } = await import('../eval/index.js');
    const r = parseArgs(['evals/foo.eval.yaml']);
    assert.equal(r.evalFile, 'evals/foo.eval.yaml');
    assert.equal(r.refine, false);
    assert.equal(r.maxIter, 5);
  });

  test('--refine flag sets refine=true', async () => {
    const { parseArgs } = await import('../eval/index.js');
    const r = parseArgs(['--refine', 'evals/foo.eval.yaml']);
    assert.equal(r.refine, true);
    assert.equal(r.evalFile, 'evals/foo.eval.yaml');
  });

  test('--max-iter sets maxIter', async () => {
    const { parseArgs } = await import('../eval/index.js');
    const r = parseArgs(['--refine', '--max-iter', '3', 'evals/foo.eval.yaml']);
    assert.equal(r.maxIter, 3);
  });

  test('# and everything after it is ignored', async () => {
    const { parseArgs } = await import('../eval/index.js');
    const r = parseArgs(['evals/foo.eval.yaml', '#', 'score', 'only']);
    assert.equal(r.evalFile, 'evals/foo.eval.yaml');
  });

  test('first positional arg wins when multiple appear', async () => {
    const { parseArgs } = await import('../eval/index.js');
    const r = parseArgs(['evals/first.yaml', 'evals/second.yaml']);
    assert.equal(r.evalFile, 'evals/first.yaml');
  });

  test('throws when no eval file is provided', async () => {
    const { parseArgs } = await import('../eval/index.js');
    assert.throws(() => parseArgs([]), /Usage/i);
  });

  test('throws when only flags are provided with no eval file', async () => {
    const { parseArgs } = await import('../eval/index.js');
    assert.throws(() => parseArgs(['--refine', '--max-iter', '3']), /Usage/i);
  });
});

// ---------------------------------------------------------------------------
// loadEvalFile
// ---------------------------------------------------------------------------

describe('loadEvalFile', () => {
  test('parses a valid eval YAML and resolves fixture file contents', async () => {
    const { loadEvalFile } = await import('../eval/load.js');

    const dir = tmpDir();
    const promptFile = join(dir, 'my-prompt.txt');
    const fixtureFile = join(dir, 'fixture.md');
    writeFileSync(promptFile, 'Hello {{NAME}}\n', 'utf8');
    writeFileSync(fixtureFile, '# fixture content\n', 'utf8');

    const evalYaml = `
name: test-eval
prompt: ${promptFile}
placeholders:
  - NAME
  - DOC
test_cases:
  - id: case-one
    vars:
      NAME: "world"
      DOC: ${fixtureFile}
    criteria:
      - "Output is non-empty"
`;
    const evalFile = join(dir, 'test.eval.yaml');
    writeFileSync(evalFile, evalYaml, 'utf8');

    const result = loadEvalFile(evalFile);
    assert.equal(result.name, 'test-eval');
    assert.equal(result.prompt, promptFile);
    assert.equal(result.testCases.length, 1);
    assert.equal(result.testCases[0]!.vars['NAME'], 'world');
    assert.equal(result.testCases[0]!.vars['DOC'], '# fixture content\n');
    assert.deepEqual(result.testCases[0]!.criteria, ['Output is non-empty']);
  });

  test('throws if prompt file does not exist', async () => {
    const { loadEvalFile } = await import('../eval/load.js');

    const dir = tmpDir();
    const evalYaml = `
name: bad-eval
prompt: /nonexistent/path/prompt.txt
placeholders: []
test_cases:
  - id: case-one
    vars: {}
    criteria:
      - "something"
`;
    const evalFile = join(dir, 'bad.eval.yaml');
    writeFileSync(evalFile, evalYaml, 'utf8');

    assert.throws(() => loadEvalFile(evalFile), /prompt file not found/i);
  });

  test('throws if a declared placeholder is missing from a test case vars', async () => {
    const { loadEvalFile } = await import('../eval/load.js');

    const dir = tmpDir();
    const promptFile = join(dir, 'prompt.txt');
    writeFileSync(promptFile, 'Hello {{NAME}}\n', 'utf8');

    const evalYaml = `
name: missing-var-eval
prompt: ${promptFile}
placeholders:
  - NAME
  - MISSING_VAR
test_cases:
  - id: case-one
    vars:
      NAME: "hello"
    criteria:
      - "something"
`;
    const evalFile = join(dir, 'missing.eval.yaml');
    writeFileSync(evalFile, evalYaml, 'utf8');

    assert.throws(() => loadEvalFile(evalFile), /MISSING_VAR/);
  });

  test('throws if test_cases is empty', async () => {
    const { loadEvalFile } = await import('../eval/load.js');

    const dir = tmpDir();
    const promptFile = join(dir, 'prompt.txt');
    writeFileSync(promptFile, 'Hello\n', 'utf8');

    const evalYaml = `
name: empty-eval
prompt: ${promptFile}
placeholders: []
test_cases: []
`;
    const evalFile = join(dir, 'empty.eval.yaml');
    writeFileSync(evalFile, evalYaml, 'utf8');

    assert.throws(() => loadEvalFile(evalFile));
  });
});

// ---------------------------------------------------------------------------
// substituteVars
// ---------------------------------------------------------------------------

describe('substituteVars', () => {
  test('replaces single placeholder', async () => {
    const { substituteVars } = await import('../eval/runner.js');
    assert.equal(substituteVars('Hello {{NAME}}', { NAME: 'world' }), 'Hello world');
  });

  test('replaces multiple placeholders', async () => {
    const { substituteVars } = await import('../eval/runner.js');
    assert.equal(
      substituteVars('{{A}} and {{B}}', { A: 'foo', B: 'bar' }),
      'foo and bar',
    );
  });

  test('replaces repeated placeholder all occurrences', async () => {
    const { substituteVars } = await import('../eval/runner.js');
    assert.equal(
      substituteVars('{{X}} {{X}} {{X}}', { X: 'hi' }),
      'hi hi hi',
    );
  });

  test('leaves unknown placeholders unchanged', async () => {
    const { substituteVars } = await import('../eval/runner.js');
    assert.equal(
      substituteVars('{{KNOWN}} {{UNKNOWN}}', { KNOWN: 'ok' }),
      'ok {{UNKNOWN}}',
    );
  });
});

// ---------------------------------------------------------------------------
// runPrompt
// ---------------------------------------------------------------------------

describe('runPrompt', () => {
  let originalPath: string;

  beforeEach(() => { originalPath = process.env['PATH'] ?? ''; });
  afterEach(() => { process.env['PATH'] = originalPath; });

  test('substitutes vars and returns Claude output text', async () => {
    const { runPrompt } = await import('../eval/runner.js');
    installMockClaude('the output text');

    const dir = tmpDir();
    const templatePath = join(dir, 'template.txt');
    writeFileSync(templatePath, 'Process: {{INPUT}}\n', 'utf8');

    const result = await runPrompt(templatePath, { INPUT: 'test data' });
    assert.equal(result.trim(), 'the output text');
  });

  test('strips prompt header before substitution', async () => {
    const { runPrompt } = await import('../eval/runner.js');

    const mockDir = tmpDir();
    const responseFile = join(mockDir, 'response.ndjson');
    const promptCapture = join(mockDir, 'captured-prompt.txt');
    writeFileSync(responseFile,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0.001 }) + '\n',
    );
    const mockScript = join(mockDir, 'claude');
    writeFileSync(mockScript,
      `#!/usr/bin/env bash\nprintf '%s' "$2" > "${promptCapture}"\ncat "${responseFile}"\nexit 0\n`,
    );
    chmodSync(mockScript, 0o755);
    const orig = process.env['PATH'] ?? '';
    process.env['PATH'] = `${mockDir}:${orig}`;

    const dir = tmpDir();
    const templatePath = join(dir, 'template.txt');
    writeFileSync(templatePath,
      '# ============\n# Header line\n# ============\n\nActual content {{VAR}}\n',
    );

    await runPrompt(templatePath, { VAR: 'substituted' });

    const captured = readFileSync(promptCapture, 'utf8');
    assert.ok(!captured.includes('# Header line'), 'Header should be stripped');
    assert.ok(captured.includes('substituted'), 'Var should be substituted');

    process.env['PATH'] = orig;
  });
});

// ---------------------------------------------------------------------------
// judgeOutput
// ---------------------------------------------------------------------------

describe('judgeOutput', () => {
  let originalPath: string;

  beforeEach(() => { originalPath = process.env['PATH'] ?? ''; });
  afterEach(() => { process.env['PATH'] = originalPath; });

  test('returns pass:true when criterion is satisfied', async () => {
    const { judgeOutput } = await import('../eval/judge.js');
    installMockClaude('{"pass": true, "reason": "Output clearly satisfies the criterion"}');

    const result = await judgeOutput('{"goal": "test", "steps": []}', 'Output is valid JSON');
    assert.equal(result.pass, true);
    assert.equal(result.criterion, 'Output is valid JSON');
    assert.ok(result.reason.length > 0);
  });

  test('returns pass:false when criterion is not satisfied', async () => {
    const { judgeOutput } = await import('../eval/judge.js');
    installMockClaude('{"pass": false, "reason": "Output does not contain a steps array"}');

    const result = await judgeOutput('not json at all', 'Output is valid JSON');
    assert.equal(result.pass, false);
    assert.ok(result.reason.includes('steps array') || result.reason.length > 0);
  });

  test('judgeAllCriteria returns one result per criterion', async () => {
    const { judgeAllCriteria } = await import('../eval/judge.js');
    // Mock returns pass:true — all criteria will pass
    installMockClaude('{"pass": true, "reason": "Good"}');

    const criteria = ['Criterion A', 'Criterion B', 'Criterion C'];
    const results = await judgeAllCriteria('some output', criteria);

    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.criterion), criteria);
  });
});

// ---------------------------------------------------------------------------
// refinePrompt
// ---------------------------------------------------------------------------

describe('refinePrompt', () => {
  let originalPath: string;

  beforeEach(() => { originalPath = process.env['PATH'] ?? ''; });
  afterEach(() => { process.env['PATH'] = originalPath; });

  test('returns improved template text from Claude response', async () => {
    const { refinePrompt } = await import('../eval/refine.js');
    installMockClaude('{"template": "Improved template content with better instructions"}');

    const dir = tmpDir();
    const templatePath = join(dir, 'template.txt');
    writeFileSync(templatePath, 'Original template {{PLACEHOLDER}}\n', 'utf8');

    const failures = [{
      caseId: 'test-case',
      vars: { PLACEHOLDER: 'value' },
      output: 'bad output',
      failedCriteria: [{ criterion: 'Output is valid JSON', pass: false, reason: 'Not JSON' }],
    }];

    const result = await refinePrompt(templatePath, failures);
    assert.ok(result.includes('Improved template content'), 'Should return Claude response');
  });

  test('saveRefinedTemplate preserves doc header and writes new body', async () => {
    const { saveRefinedTemplate } = await import('../eval/refine.js');

    const dir = tmpDir();
    const templatePath = join(dir, 'template.txt');
    const header = '# ============\n# My Header\n# ============\n\n';
    writeFileSync(templatePath, header + 'Original body\n', 'utf8');

    saveRefinedTemplate(templatePath, 'New improved body');

    const result = readFileSync(templatePath, 'utf8');
    assert.ok(result.includes('# My Header'), 'Header should be preserved');
    assert.ok(result.includes('New improved body'), 'New body should be written');
    assert.ok(!result.includes('Original body'), 'Old body should be replaced');
  });

  test('unwraps double-wrapped template when Claude nests JSON inside the field', async () => {
    const { refinePrompt } = await import('../eval/refine.js');
    // Claude sometimes returns {"template": "{\"template\": \"actual content\"}"}
    const nested = JSON.stringify({ template: 'unwrapped content here' });
    installMockClaude(JSON.stringify({ template: nested }));

    const dir = tmpDir();
    const templatePath = join(dir, 'template.txt');
    writeFileSync(templatePath, 'Original {{PLACEHOLDER}}\n', 'utf8');

    const failures = [{
      caseId: 'test-case',
      vars: { PLACEHOLDER: 'value' },
      output: 'bad output',
      failedCriteria: [{ criterion: 'Valid JSON', pass: false, reason: 'Not JSON' }],
    }];

    const result = await refinePrompt(templatePath, failures);
    assert.ok(result.includes('unwrapped content here'), 'Should unwrap nested template');
    assert.ok(!result.startsWith('{'), 'Result should not start with {');
  });
});

// ---------------------------------------------------------------------------
// collectFailures
// ---------------------------------------------------------------------------

describe('collectFailures', () => {
  test('returns only failing results with their failed criteria', async () => {
    const { collectFailures } = await import('../eval/index.js');

    const evalFile = {
      name: 'test',
      prompt: '/fake/prompt.txt',
      placeholders: [],
      testCases: [
        { id: 'pass-case', vars: { A: 'a' }, criteria: ['C1'] },
        { id: 'fail-case', vars: { A: 'b' }, criteria: ['C2', 'C3'] },
      ],
    };

    const run = {
      evalName: 'test',
      templatePath: '/fake/prompt.txt',
      totalPass: 1,
      totalCriteria: 3,
      results: [
        { caseId: 'pass-case', output: 'ok', passCount: 1, failCount: 0, criteria: [{ criterion: 'C1', pass: true, reason: 'good' }] },
        { caseId: 'fail-case', output: 'bad', passCount: 0, failCount: 2, criteria: [{ criterion: 'C2', pass: false, reason: 'wrong' }, { criterion: 'C3', pass: false, reason: 'also wrong' }] },
      ],
    };

    const failures = collectFailures(run, evalFile);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.caseId, 'fail-case');
    assert.equal(failures[0]!.output, 'bad');
    assert.equal(failures[0]!.failedCriteria.length, 2);
    assert.equal(failures[0]!.failedCriteria[0]!.criterion, 'C2');
  });

  test('returns empty array when all results pass', async () => {
    const { collectFailures } = await import('../eval/index.js');

    const evalFile = {
      name: 'test',
      prompt: '/fake/prompt.txt',
      placeholders: [],
      testCases: [{ id: 'pass-case', vars: {}, criteria: ['C1'] }],
    };

    const run = {
      evalName: 'test',
      templatePath: '/fake/prompt.txt',
      totalPass: 1,
      totalCriteria: 1,
      results: [
        { caseId: 'pass-case', output: 'ok', passCount: 1, failCount: 0, criteria: [{ criterion: 'C1', pass: true, reason: 'good' }] },
      ],
    };

    const failures = collectFailures(run, evalFile);
    assert.equal(failures.length, 0);
  });
});

// ---------------------------------------------------------------------------
// best-run restoration
// ---------------------------------------------------------------------------

describe('best-run restoration', () => {
  let originalArgv: string[];
  let originalPath: string;

  beforeEach(() => {
    originalArgv = process.argv.slice();
    originalPath = process.env['PATH'] ?? '';
  });
  afterEach(() => {
    process.argv.length = 0;
    for (const a of originalArgv) process.argv.push(a);
    process.env['PATH'] = originalPath;
  });

  test('restores best template when refinement regresses on final iteration', async () => {
    const { main } = await import('../eval/index.js');

    const dir = tmpDir();

    // Template file — starts as "Template v0"
    const templatePath = join(dir, 'template.txt');
    writeFileSync(templatePath, '# Header\n\nTemplate v0 {{INPUT}}\n', 'utf8');

    // Fixture
    const fixturePath = join(dir, 'fixture.txt');
    writeFileSync(fixturePath, 'fixture content', 'utf8');

    // Eval YAML: 1 test case, 1 criterion
    const evalYaml = `
name: restoration-test
prompt: ${templatePath}
placeholders:
  - INPUT
test_cases:
  - id: case-one
    vars:
      INPUT: ${fixturePath}
    criteria:
      - "Output is non-empty"
`;
    const evalFilePath = join(dir, 'test.eval.yaml');
    writeFileSync(evalFilePath, evalYaml, 'utf8');

    // Sequential mock claude: counter tracks call number
    const mockDir = tmpDir();
    const counterFile = join(mockDir, 'counter');
    writeFileSync(counterFile, '0', 'utf8');

    // Responses (in order of claude invocation):
    // Call 0: runPrompt (iter 0 scoring) → text output
    // Call 1: judgeOutput (iter 0 scoring) → pass:true (score 1/1, all pass → no refine loop enters)
    // Since iter 0 all pass, the refine loop is skipped entirely.
    //
    // We need the initial run to FAIL so refinement starts.
    // Call 0: runPrompt → text output
    // Call 1: judgeOutput → pass:false (score 0/1, enters refine loop)
    // Call 2: refinePrompt → {template: "Refined template v1"}  (saves to disk)
    // Call 3: runPrompt (iter 1 re-score) → text output
    // Call 4: judgeOutput (iter 1 re-score) → pass:true (score 1/1, new best)
    // Call 5: refinePrompt → {template: "Refined template v2"}  (saves to disk, but iter 2 regresses)
    // Call 6: runPrompt (iter 2 re-score) → text output
    // Call 7: judgeOutput (iter 2 re-score) → pass:false (score 0/1, regression)
    // → max-iter=2 exhausted, best was iter 1 → restore "# Header\n\nRefined template v1\n"

    const responses = [
      // Call 0: runPrompt initial
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'initial output' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n',
      // Call 1: judgeOutput initial → FAIL
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"pass": false, "reason": "not good enough"}' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n',
      // Call 2: refinePrompt → template v1
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"template": "Refined template v1 {{INPUT}}"}' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n',
      // Call 3: runPrompt iter 1 re-score
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'iter1 output' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n',
      // Call 4: judgeOutput iter 1 → PASS (new best: 1/1)
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"pass": true, "reason": "looks good"}' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n',
      // Call 5: refinePrompt → template v2 (but iter 2 will regress)
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"template": "Refined template v2 {{INPUT}}"}' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n',
      // Call 6: runPrompt iter 2 re-score
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'iter2 output' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n',
      // Call 7: judgeOutput iter 2 → FAIL (regression: 0/1)
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"pass": false, "reason": "worse now"}' }] } }) + '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n',
    ];

    for (let i = 0; i < responses.length; i++) {
      writeFileSync(join(mockDir, `response-${i}.ndjson`), responses[i]!, 'utf8');
    }

    const mockScript = join(mockDir, 'claude');
    writeFileSync(mockScript,
      `#!/usr/bin/env bash\n` +
      `COUNT=$(cat "${counterFile}" 2>/dev/null || echo 0)\n` +
      `echo $((COUNT + 1)) > "${counterFile}"\n` +
      `cat "${mockDir}/response-${`\${COUNT}`}.ndjson"\n` +
      `exit 0\n`,
      'utf8',
    );
    chmodSync(mockScript, 0o755);
    process.env['PATH'] = `${mockDir}:${originalPath}`;

    process.argv.length = 0;
    for (const a of ['node', 'eval', '--refine', '--max-iter', '2', evalFilePath]) process.argv.push(a);

    await main();

    // After exhausting 2 iterations with regression on iter 2,
    // the best run was iter 1 (1/1 pass) → template v1 should be on disk
    const finalTemplate = readFileSync(templatePath, 'utf8');
    assert.ok(finalTemplate.includes('Refined template v1'), `Expected v1 to be restored, got: ${finalTemplate}`);
    assert.ok(!finalTemplate.includes('Refined template v2'), 'v2 should not be on disk after restoration');
  });
});
