// ============================================================================
// STATUSLINE
// ============================================================================
// The context gauge executant renders above its TUI footer:
//
//   executant   main  ━━━━━━━━━━ 81% 162.2k/200k
//   └ repo      └ branch  └ 10-cell gauge, coloured by how full the context is
//
// It reports EXECUTANT's own numbers, never those of the Claude Code session
// that launched it: each prompt step is a separate `claude -p` child with its
// own context window, and a parent session's context is not observable from a
// child process. The gauge therefore describes the session executant itself
// spawned — one `claude -p` per prompt step, each with its own window.
//
// Everything here is pure except `readRepoInfo`, which shells out to git and
// resolves undefined on any failure — outside a repo the bar simply drops the
// repo/branch segment. Disable the bar entirely with EXECUTANT_STATUSLINE=0.

import { basename } from "node:path";
import { spawn } from "node:child_process";
import type { TokenUsage } from "../types.js";

/** Statusline is enabled by default; opt out with EXECUTANT_STATUSLINE=0. */
export function statusLineEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["EXECUTANT_STATUSLINE"] !== "0";
}

// ----------------------------------------------------------------------------
// Context window
// ----------------------------------------------------------------------------

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/**
 * The running model's context window, which sizes the gauge.
 * Extended-context models carry a `[1m]` suffix in their id.
 */
export function contextWindowSize(model: string): number {
  return model.toLowerCase().includes("[1m]")
    ? EXTENDED_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * How much of its context window a session occupies, from the usage of ONE
 * of its turns. Cache creation and cache read both sit in the same window as
 * fresh input; output tokens do not.
 *
 * Apply this to a single turn's usage and take the latest — that is the
 * session's current fill. Never apply it to the Claude CLI's final `result`
 * usage, which sums every turn: each turn re-reads the cached prefix, so the
 * total measures throughput, not occupancy, and a long step totalled 3781.1k
 * against a 200k window. `src/tasks/claude.ts` therefore computes this from
 * the per-turn `assistant` messages and emits it as `output:context`.
 */
export function contextTokens(usage: TokenUsage | undefined): number {
  return usage
    ? usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens
    : 0;
}

// ----------------------------------------------------------------------------
// Gauge
// ----------------------------------------------------------------------------

export const GAUGE_WIDTH = 10;
export const GAUGE_CHAR = "━";
/** Percentages at which the gauge changes colour. */
const WARN_PCT = 70;
const HIGH_PCT = 90;

export type GaugeLevel = "ok" | "warn" | "high";

interface Gauge {
  /** Whole percent of the window used, capped at 100. */
  pct: number;
  /** Gauge cells drawn in the level colour, and the remainder drawn dim. */
  filled: string;
  empty: string;
  level: GaugeLevel;
  /** e.g. "162.2k" and "200k" (or "1M" for an extended-context model). */
  used: string;
  limit: string;
}

/** Truncates to one decimal without rounding up, so a gauge never overstates. */
function formatK(n: number): string {
  return `${Math.floor(n / 1000)}.${Math.floor((n % 1000) / 100)}k`;
}

/** Whole-unit label for the window itself: "200k", "1M". */
function formatLimit(size: number): string {
  return size >= 1_000_000
    ? `${size / 1_000_000}M`
    : `${Math.round(size / 1000)}k`;
}

export function buildGauge(
  tokens: number,
  size: number,
  width = GAUGE_WIDTH,
): Gauge {
  const pct = size > 0 ? Math.min(100, Math.floor((tokens * 100) / size)) : 0;
  const filled = Math.floor((pct * width) / 100);
  return {
    pct,
    filled: GAUGE_CHAR.repeat(filled),
    empty: GAUGE_CHAR.repeat(width - filled),
    level: pct >= HIGH_PCT ? "high" : pct >= WARN_PCT ? "warn" : "ok",
    used: formatK(tokens),
    limit: formatLimit(size),
  };
}

// ----------------------------------------------------------------------------
// Repo
// ----------------------------------------------------------------------------

export interface RepoInfo {
  name: string;
  /** Short SHA when HEAD is detached; absent in a repo with no commits yet. */
  branch?: string;
}

/** Truncates to fit, appending an ellipsis rather than silently cutting off. */
function truncateText(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (s.length <= maxWidth) return s;
  if (maxWidth === 1) return "…";
  return s.slice(0, maxWidth - 1) + "…";
}

/** Width of the 3-space gap StatusBar renders between the repo name and branch. */
const REPO_BRANCH_GAP = 3;

/**
 * Shrinks repo name and branch to fit within `maxWidth` combined, so a long
 * branch name (or, in an unusually-named checkout, a long directory name)
 * never wraps the status bar onto a second line. A short name keeps its full
 * length and any width it doesn't use is handed to the branch.
 */
export function fitRepoLabel(repo: RepoInfo, maxWidth: number): RepoInfo {
  if (!repo.branch) return { name: truncateText(repo.name, maxWidth) };

  const available = maxWidth - REPO_BRANCH_GAP;
  if (repo.name.length + repo.branch.length <= available) return repo;
  if (available <= 0) return { name: truncateText(repo.name, maxWidth) };

  const half = Math.floor(available / 2);
  const nameWidth = Math.min(repo.name.length, half);
  const branchWidth = Math.max(1, available - nameWidth);
  return {
    name: truncateText(repo.name, nameWidth),
    branch: truncateText(repo.branch, branchWidth),
  };
}

/** Runs a git subcommand in `cwd`, resolving undefined on any failure. */
function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 2000,
): Promise<string | undefined> {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn("git", ["-C", cwd, ...args], {
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolveResult(undefined);
      return;
    }
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolveResult(undefined));
    child.on("close", (code) => resolveResult(code === 0 ? out : undefined));
  });
}

/**
 * Repo name and branch for `cwd`, in one git call. A detached HEAD reports
 * "HEAD", which is replaced by the short SHA — the branch name is only useful
 * here as "where am I", and "HEAD" answers nothing.
 */
export async function readRepoInfo(cwd: string): Promise<RepoInfo | undefined> {
  const out = await runGit(
    ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"],
    cwd,
  );
  if (!out) return undefined;
  const [toplevel, branch] = out.trim().split("\n");
  if (!toplevel) return undefined;
  const name = basename(toplevel);
  if (branch && branch !== "HEAD") return { name, branch };
  const sha = (await runGit(["rev-parse", "--short", "HEAD"], cwd))?.trim();
  return sha ? { name, branch: sha } : { name };
}
