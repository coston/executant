// ============================================================================
// STATUSLINE — unit tests
// ============================================================================
// Tests for src/lib/statusline.ts: settings discovery (project walk-up, local
// overriding shared, home-dir fallback, malformed-file tolerance), payload
// shape, and running the statusline command itself (stdin/stdout plumbing,
// ANSI stripping, non-zero exit, and timeout — all best-effort, never throws).

import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findStatusLineCommand,
  buildStatusLinePayload,
  runStatusLine,
  statusLineEnabled,
} from "../lib/statusline.js";

// ----------------------------------------------------------------------------
// findStatusLineCommand
// ----------------------------------------------------------------------------

describe("findStatusLineCommand", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "executant-statusline-project-"));
    home = mkdtempSync(join(tmpdir(), "executant-statusline-home-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function writeSettings(dir: string, file: string, command: string) {
    const claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, file),
      JSON.stringify({ statusLine: { type: "command", command } }),
    );
  }

  test("finds the command in the cwd's own .claude/settings.json", () => {
    writeSettings(root, "settings.json", "echo project");
    assert.equal(findStatusLineCommand(root, home), "echo project");
  });

  test("walks up from a nested cwd to find an ancestor's settings", () => {
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeSettings(root, "settings.json", "echo root");
    assert.equal(findStatusLineCommand(nested, home), "echo root");
  });

  test("settings.local.json overrides settings.json in the same directory", () => {
    writeSettings(root, "settings.json", "echo shared");
    writeSettings(root, "settings.local.json", "echo local");
    assert.equal(findStatusLineCommand(root, home), "echo local");
  });

  test("falls back to the home directory when no project settings exist", () => {
    writeSettings(home, "settings.json", "echo home");
    assert.equal(findStatusLineCommand(root, home), "echo home");
  });

  test("a nearer ancestor's settings win over the home directory", () => {
    writeSettings(root, "settings.json", "echo root");
    writeSettings(home, "settings.json", "echo home");
    assert.equal(findStatusLineCommand(root, home), "echo root");
  });

  test("returns undefined when nothing is configured anywhere", () => {
    assert.equal(findStatusLineCommand(root, home), undefined);
  });

  test("tolerates malformed JSON instead of throwing", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{ not json");
    assert.equal(findStatusLineCommand(root, home), undefined);
  });

  test("tolerates a settings file with no statusLine key", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
    );
    assert.equal(findStatusLineCommand(root, home), undefined);
  });
});

// ----------------------------------------------------------------------------
// buildStatusLinePayload
// ----------------------------------------------------------------------------

describe("buildStatusLinePayload", () => {
  test("shapes a payload approximating Claude Code's own statusLine input", () => {
    const payload = buildStatusLinePayload({
      workflow: { sourcePath: "/repo/tasks/todo/build.yaml" },
      sessionId: "abc-123",
      model: "sonnet",
      totalCostUsd: 0.42,
      elapsedMs: 5000,
    });
    assert.equal(payload.hook_event_name, "Status");
    assert.equal(payload.session_id, "abc-123");
    assert.equal(payload.model.id, "sonnet");
    assert.equal(payload.workspace.project_dir, "/repo/tasks/todo");
    assert.equal(payload.cost.total_cost_usd, 0.42);
    assert.equal(payload.cost.total_duration_ms, 5000);
  });

  test("falls back to cwd as project_dir when the workflow has no sourcePath", () => {
    const payload = buildStatusLinePayload({
      workflow: {},
      sessionId: "abc-123",
      model: "sonnet",
      totalCostUsd: 0,
      elapsedMs: 0,
    });
    assert.equal(payload.workspace.project_dir, process.cwd());
  });
});

// ----------------------------------------------------------------------------
// runStatusLine
// ----------------------------------------------------------------------------

describe("runStatusLine", () => {
  test("pipes the payload to stdin and returns the command's first stdout line", async () => {
    const out = await runStatusLine("cat", { hello: "world" });
    assert.equal(out, JSON.stringify({ hello: "world" }));
  });

  test("returns only the first line when the command prints more than one", async () => {
    const out = await runStatusLine("printf 'first line\\nsecond line\\n'", {});
    assert.equal(out, "first line");
  });

  test("strips ANSI escape codes from the output", async () => {
    const out = await runStatusLine("printf '\\033[31mred\\033[0m\\n'", {});
    assert.equal(out, "red");
  });

  test("returns undefined when the command exits non-zero", async () => {
    const out = await runStatusLine("exit 1", {});
    assert.equal(out, undefined);
  });

  test("returns undefined when the command does not exist", async () => {
    const out = await runStatusLine("executant-statusline-nonexistent-cmd", {});
    assert.equal(out, undefined);
  });

  test("returns undefined when the command prints nothing", async () => {
    const out = await runStatusLine("true", {});
    assert.equal(out, undefined);
  });

  test("returns undefined when the command exceeds its timeout", async () => {
    const out = await runStatusLine("sleep 2", {}, 100);
    assert.equal(out, undefined);
  });
});

// ----------------------------------------------------------------------------
// statusLineEnabled
// ----------------------------------------------------------------------------

describe("statusLineEnabled", () => {
  test("is enabled by default", () => {
    assert.equal(statusLineEnabled({}), true);
  });

  test("is disabled by EXECUTANT_STATUSLINE=0", () => {
    assert.equal(statusLineEnabled({ EXECUTANT_STATUSLINE: "0" }), false);
  });

  test("any other value leaves it enabled", () => {
    assert.equal(statusLineEnabled({ EXECUTANT_STATUSLINE: "false" }), true);
  });
});
