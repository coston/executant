// ============================================================================
// LOGGER TESTS
// ============================================================================
// Tests for findExecutantLocalDir, Logger, and withLogger from src/logger.ts.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findExecutantLocalDir,
  createLogger,
  type Logger,
  withLogger,
} from "../logger.js";
import type { Event, Workflow } from "../types.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `executant-logger-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const FAKE_WORKFLOW: Workflow = { goal: "test goal", tasks: [] };

async function* makeGen(events: Event[]): AsyncGenerator<Event> {
  for (const e of events) yield e;
}

function readLogFile(logDir: string): string {
  const logFiles = readdirSync(logDir).filter((f) => f.endsWith(".log"));
  assert.equal(logFiles.length, 1, "expected exactly one log file");
  return readFileSync(join(logDir, logFiles[0]), "utf8");
}

// ----------------------------------------------------------------------------
// findExecutantLocalDir
// ----------------------------------------------------------------------------

describe("findExecutantLocalDir", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("finds .claude/executant.local/ in the start directory", () => {
    const target = join(tmpRoot, ".claude", "executant.local");
    mkdirSync(target, { recursive: true });
    const result = findExecutantLocalDir(tmpRoot);
    assert.equal(result, target);
  });

  test("finds .claude/executant.local/ by walking up one level", () => {
    const target = join(tmpRoot, ".claude", "executant.local");
    mkdirSync(target, { recursive: true });
    const child = join(tmpRoot, "child");
    mkdirSync(child);
    const result = findExecutantLocalDir(child);
    assert.equal(result, target);
  });

  test("returns null when not found anywhere up the tree", () => {
    const result = findExecutantLocalDir(tmpRoot);
    assert.equal(result, null);
  });
});

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

describe("Logger", () => {
  let logDir: string;
  let prevLogEnv: string | undefined;

  beforeEach(() => {
    logDir = makeTmpDir();
    prevLogEnv = process.env["EXECUTANT_LOG"];
    delete process.env["EXECUTANT_LOG"];
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    if (prevLogEnv === undefined) delete process.env["EXECUTANT_LOG"];
    else process.env["EXECUTANT_LOG"] = prevLogEnv;
  });

  test("workflow:start creates logDir", () => {
    const logger = createLogger(logDir, "my-task");
    logger.observe({ type: "workflow:start", workflow: FAKE_WORKFLOW });
    assert.ok(existsSync(logDir));
  });

  test("workflow:start creates log file with header", () => {
    const logger = createLogger(logDir, "my-task");
    logger.observe({ type: "workflow:start", workflow: FAKE_WORKFLOW });
    const content = readLogFile(logDir);
    assert.ok(content.includes("# Execution Log"));
    assert.ok(content.includes("my-task"));
  });

  test("step:start appends step header to log", () => {
    const logger = createLogger(logDir, "test-task");
    logger.observe({ type: "workflow:start", workflow: FAKE_WORKFLOW });
    logger.observe({ type: "step:start", index: 0, name: "my-step" });
    const content = readLogFile(logDir);
    assert.ok(content.includes("Step 1: my-step"));
  });

  test("output:text is appended to log file", () => {
    const logger = createLogger(logDir, "test-task");
    logger.observe({ type: "workflow:start", workflow: FAKE_WORKFLOW });
    logger.observe({ type: "step:start", index: 0, name: "step-a" });
    logger.observe({ type: "output:text", index: 0, text: "hello world" });
    const content = readLogFile(logDir);
    assert.ok(content.includes("hello world"));
  });

  test("output:tool is appended with tool summary", () => {
    const logger = createLogger(logDir, "test-task");
    logger.observe({ type: "workflow:start", workflow: FAKE_WORKFLOW });
    logger.observe({ type: "step:start", index: 0, name: "step-b" });
    logger.observe({
      type: "output:tool",
      index: 0,
      tool: "Read",
      input: { file_path: "/foo/bar.ts" },
    });
    const content = readLogFile(logDir);
    assert.ok(content.includes("[Read]"));
    assert.ok(content.includes("/foo/bar.ts"));
  });

  test("EXECUTANT_LOG=0 makes observe a no-op — log file never created", () => {
    process.env["EXECUTANT_LOG"] = "0";
    const logger = createLogger(logDir, "test-task");
    logger.observe({ type: "workflow:start", workflow: FAKE_WORKFLOW });
    const logFiles = readdirSync(logDir).filter((f) => f.endsWith(".log"));
    assert.equal(logFiles.length, 0);
  });

  test("recovers when the log dir is deleted mid-run (e.g. by `git clean`)", () => {
    const logger = createLogger(logDir, "resilient-task");
    logger.observe({ type: "workflow:start", workflow: FAKE_WORKFLOW });
    logger.observe({ type: "step:start", index: 0, name: "step-a" });

    // Simulate a workflow step wiping the workspace dir executant logs into.
    rmSync(logDir, { recursive: true, force: true });
    assert.ok(!existsSync(logDir));

    // Subsequent writes must self-heal rather than flood with ENOENT.
    assert.doesNotThrow(() =>
      logger.observe({ type: "output:text", index: 0, text: "after wipe" }),
    );
    assert.ok(existsSync(logDir), "log dir should be recreated");
    assert.ok(readLogFile(logDir).includes("after wipe"));
  });

  test("observe swallows errors and does not throw", () => {
    const logger = createLogger(logDir, "test-task");
    // Skip workflow:start so logFile is not set — appendLog silently returns
    assert.doesNotThrow(() =>
      logger.observe({ type: "output:text", index: -1, text: "ignored" }),
    );
  });
});

// ----------------------------------------------------------------------------
// withLogger
// ----------------------------------------------------------------------------

describe("withLogger", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  test("passes all events through unchanged", async () => {
    const events: Event[] = [
      { type: "workflow:start", workflow: FAKE_WORKFLOW },
      { type: "log", level: "info", text: "hello" },
    ];
    const logger = createLogger(logDir, "passthrough-test");
    const collected: Event[] = [];
    for await (const e of withLogger(makeGen(events), logger))
      collected.push(e);
    assert.deepEqual(collected, events);
  });

  test("calls observe once per event", async () => {
    const events: Event[] = [
      { type: "workflow:start", workflow: FAKE_WORKFLOW },
      { type: "log", level: "info", text: "a" },
      { type: "log", level: "warn", text: "b" },
    ];
    const observedEvents: Event[] = [];
    const mockLogger = {
      observe: (e: Event) => observedEvents.push(e),
    } as unknown as Logger;
    for await (const _ of withLogger(makeGen(events), mockLogger)) {
      /* drain */
    }
    assert.equal(observedEvents.length, 3);
    assert.deepEqual(observedEvents, events);
  });
});
