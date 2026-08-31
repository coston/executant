// ============================================================================
// STATUSLINE — unit tests
// ============================================================================
// Tests for src/lib/statusline.ts: the enable switch, context-window sizing,
// the gauge's arithmetic and formatting (including the exact string the bar
// renders), and reading repo/branch from git — which degrades to undefined
// outside a repository rather than throwing.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  buildGauge,
  contextTokens,
  contextWindowSize,
  fitRepoLabel,
  readRepoInfo,
  statusLineEnabled,
  DEFAULT_CONTEXT_WINDOW,
  EXTENDED_CONTEXT_WINDOW,
  GAUGE_CHAR,
  GAUGE_WIDTH,
} from "../lib/statusline.js";
import type { TokenUsage } from "../types.js";

const USAGE: TokenUsage = {
  inputTokens: 8500,
  outputTokens: 1200,
  cacheCreationTokens: 5000,
  cacheReadTokens: 2000,
};

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
    assert.equal(statusLineEnabled({ EXECUTANT_STATUSLINE: "1" }), true);
  });
});

// ----------------------------------------------------------------------------
// Context window
// ----------------------------------------------------------------------------

describe("contextWindowSize", () => {
  test("defaults to 200k", () => {
    assert.equal(contextWindowSize("sonnet"), DEFAULT_CONTEXT_WINDOW);
  });

  test("recognises the [1m] extended-context suffix", () => {
    assert.equal(
      contextWindowSize("claude-opus-5[1m]"),
      EXTENDED_CONTEXT_WINDOW,
    );
  });
});

describe("contextTokens", () => {
  test("counts cache creation and reads as context, but not output", () => {
    // 8500 input + 5000 cache creation + 2000 cache read; 1200 output excluded.
    assert.equal(contextTokens(USAGE), 15_500);
  });

  test("is zero before the first invocation finishes", () => {
    assert.equal(contextTokens(undefined), 0);
  });
});

// ----------------------------------------------------------------------------
// Gauge
// ----------------------------------------------------------------------------

/** The bar's visible text, assembled exactly as StatusBar renders it. */
function renderGauge(tokens: number, size = DEFAULT_CONTEXT_WINDOW): string {
  const g = buildGauge(tokens, size);
  return `${g.filled}${g.empty} ${g.pct}% ${g.used}/${g.limit}`;
}

describe("buildGauge", () => {
  test("renders the reference line", () => {
    assert.equal(renderGauge(162_200), "━━━━━━━━━━ 81% 162.2k/200k");
  });

  test("splits the bar at the filled/empty boundary", () => {
    const g = buildGauge(162_200, DEFAULT_CONTEXT_WINDOW);
    assert.equal(g.filled, GAUGE_CHAR.repeat(8));
    assert.equal(g.empty, GAUGE_CHAR.repeat(2));
    assert.equal(g.filled.length + g.empty.length, GAUGE_WIDTH);
  });

  test("is empty before the first invocation", () => {
    assert.equal(renderGauge(0), "━━━━━━━━━━ 0% 0.0k/200k");
  });

  test("truncates rather than rounds up, so it never overstates", () => {
    // 89.9% must not read as 90% (the colour changes at that threshold).
    const g = buildGauge(179_999, DEFAULT_CONTEXT_WINDOW);
    assert.equal(g.pct, 89);
    assert.equal(g.used, "179.9k");
  });

  test("caps a context larger than the window at 100%", () => {
    const g = buildGauge(500_000, DEFAULT_CONTEXT_WINDOW);
    assert.equal(g.pct, 100);
    assert.equal(g.empty, "");
    assert.equal(g.filled, GAUGE_CHAR.repeat(GAUGE_WIDTH));
  });

  test("sizes itself to an extended-context model", () => {
    assert.equal(
      renderGauge(250_000, EXTENDED_CONTEXT_WINDOW),
      "━━━━━━━━━━ 25% 250.0k/1M",
    );
  });

  test("changes level at 70% and 90%", () => {
    assert.equal(buildGauge(138_000, DEFAULT_CONTEXT_WINDOW).level, "ok");
    assert.equal(buildGauge(140_000, DEFAULT_CONTEXT_WINDOW).level, "warn");
    assert.equal(buildGauge(180_000, DEFAULT_CONTEXT_WINDOW).level, "high");
  });
});

// ----------------------------------------------------------------------------
// fitRepoLabel
// ----------------------------------------------------------------------------

describe("fitRepoLabel", () => {
  test("returns the repo unchanged when it already fits", () => {
    const repo = { name: "executant", branch: "main" };
    assert.deepEqual(fitRepoLabel(repo, 40), repo);
  });

  test("truncates the name when there is no branch", () => {
    assert.deepEqual(fitRepoLabel({ name: "executant" }, 5), {
      name: "exec…",
    });
  });

  test("shrinks a long branch while keeping a short name intact", () => {
    const repo = {
      name: "executant",
      branch: "operator/4-enhancement-eval-history-observability-w",
    };
    const fitted = fitRepoLabel(repo, 30);
    assert.equal(fitted.name, "executant");
    assert.ok(fitted.branch!.length <= 30 - 9 - 3);
    assert.ok(fitted.branch!.endsWith("…"));
  });

  test("shrinks both name and branch when both are long", () => {
    const repo = {
      name: "operator-job-9d914c84-85ec-410e-a24c-2ea43be588a0",
      branch: "operator/4-enhancement-eval-history-observability-w",
    };
    const fitted = fitRepoLabel(repo, 40);
    assert.ok(fitted.name.length + 3 + fitted.branch!.length <= 40);
    assert.ok(fitted.name.endsWith("…"));
    assert.ok(fitted.branch!.endsWith("…"));
  });

  test("never produces a negative-width slice", () => {
    const repo = { name: "a-very-long-repo-name-indeed", branch: "main" };
    const fitted = fitRepoLabel(repo, 1);
    assert.equal(fitted.name, "…");
  });
});

// ----------------------------------------------------------------------------
// readRepoInfo
// ----------------------------------------------------------------------------

describe("readRepoInfo", () => {
  test("reads the repo name and branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "executant-statusline-repo-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
      git("init", "-q", "-b", "trunk");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "T");
      git("commit", "-q", "--allow-empty", "-m", "init");
      const info = await readRepoInfo(dir);
      assert.equal(info?.name, dir.split("/").pop());
      assert.equal(info?.branch, "trunk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the short SHA on a detached HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "executant-statusline-detached-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "T");
      git("commit", "-q", "--allow-empty", "-m", "init");
      const sha = execFileSync("git", [
        "-C",
        dir,
        "rev-parse",
        "--short",
        "HEAD",
      ])
        .toString()
        .trim();
      git("checkout", "-q", "--detach");
      assert.equal((await readRepoInfo(dir))?.branch, sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined outside a repository rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "executant-statusline-nogit-"));
    try {
      assert.equal(await readRepoInfo(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
