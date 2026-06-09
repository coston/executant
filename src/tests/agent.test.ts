// ============================================================================
// AGENT DISPATCH — unit tests
// ============================================================================
// Tests for resolveAgentProvider in src/tasks/agent.ts.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentProvider, runAgentStructured } from "../tasks/agent.js";

// Verify runAgentStructured is a public export (not just an internal helper).
test("runAgentStructured is exported from the agent module", () => {
  assert.equal(typeof runAgentStructured, "function");
});

// Snapshot the original env value so tests don't bleed.
const ORIGINAL_PROVIDER = process.env["EXECUTANT_PROVIDER"];

function setProvider(value: string | undefined): void {
  if (value === undefined) {
    delete process.env["EXECUTANT_PROVIDER"];
  } else {
    process.env["EXECUTANT_PROVIDER"] = value;
  }
}

describe("resolveAgentProvider", () => {
  beforeEach(() => {
    setProvider(undefined);
  });

  afterEach(() => {
    setProvider(ORIGINAL_PROVIDER);
  });

  test('defaults to "claude" when no provider set', () => {
    assert.equal(resolveAgentProvider({}), "claude");
  });

  test('returns "claude" when EXECUTANT_PROVIDER=claude', () => {
    setProvider("claude");
    assert.equal(resolveAgentProvider({}), "claude");
  });

  test('returns "opencode" when EXECUTANT_PROVIDER=opencode', () => {
    setProvider("opencode");
    assert.equal(resolveAgentProvider({}), "opencode");
  });

  test("task.provider takes priority over EXECUTANT_PROVIDER env var", () => {
    setProvider("claude");
    assert.equal(resolveAgentProvider({ provider: "opencode" }), "opencode");
  });

  test("task.provider=claude overrides EXECUTANT_PROVIDER=opencode", () => {
    setProvider("opencode");
    assert.equal(resolveAgentProvider({ provider: "claude" }), "claude");
  });

  test("throws on unknown EXECUTANT_PROVIDER value", () => {
    setProvider("gemini");
    assert.throws(
      () => resolveAgentProvider({}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("gemini"));
        return true;
      },
    );
  });

  test("throws when task.provider is an unknown string", () => {
    assert.throws(
      () => resolveAgentProvider({ provider: "gpt4" as "claude" }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("gpt4"));
        return true;
      },
    );
  });
});
