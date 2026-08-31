// ============================================================================
// EVAL PROVENANCE
// ============================================================================
// Captures the "what produced this score" context for a comparison run:
// repo + commit evaluated, judge identity, and hashes of the judge prompt and
// eval spec. `comparisonFingerprint` is the stable key that tells historical
// trend reporting whether two runs are strictly comparable.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, stripPromptHeader } from "../lib/utils.js";
import type { EvalFile, RunProvenance } from "./types.js";

/**
 * The model the criterion judge runs with. Shared with judge.ts, which pins
 * this model on its Claude calls — provenance must record the judge that
 * actually ran, not an assumption about it.
 */
export function resolveJudgeModel(): string {
  return process.env["EXECUTANT_MODEL"] ?? DEFAULT_MODEL;
}

const __dir = dirname(fileURLToPath(import.meta.url));

function tryExec(cmd: string): string | undefined {
  try {
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Commit SHA currently checked out, or undefined outside a git repo. */
export function getGitSha(): string | undefined {
  return tryExec("git rev-parse HEAD");
}

/** "owner/repo" parsed from the origin remote URL (GitHub only), or undefined. */
export function getRepoSlug(): string | undefined {
  const url = tryExec("git config --get remote.origin.url");
  if (!url) return undefined;
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return match?.[1];
}

const UNSET = Symbol("unset");
let cachedJudgeVersion: string | undefined | typeof UNSET = UNSET;

/**
 * The judge CLI's version string, when it can be read (e.g. "2.1.251").
 * Memoized per process — every eval-comparison run only pays for one
 * `claude --version` spawn no matter how many eval files it covers.
 */
function getJudgeVersion(): string | undefined {
  if (cachedJudgeVersion !== UNSET) return cachedJudgeVersion;
  const out = tryExec("claude --version");
  cachedJudgeVersion = out?.split(/\s+/)[0];
  return cachedJudgeVersion;
}

/** Stable short hash (sha256, truncated) of arbitrary content. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * Hash of the judge prompt template — changes here signal a judging-regime
 * change. Hashes the header-stripped text (what judge.ts actually sends), so
 * editing only the documentation header does not flag a false regime change.
 */
export function getJudgePromptHash(): string {
  const promptPath = join(__dir, "prompts", "criterion-judge.txt");
  return hashContent(stripPromptHeader(readFileSync(promptPath, "utf8")));
}

/** Sorts an object's keys so semantically-equal vars hash identically regardless of YAML key order. */
function sortedVars(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Hash of the resolved eval spec (test cases + criteria) — changes here signal an eval-regime change. */
export function getEvalHash(evalFile: EvalFile): string {
  const canonical = JSON.stringify({
    name: evalFile.name,
    placeholders: [...evalFile.placeholders].sort(),
    testCases: [...evalFile.testCases]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((tc) => ({
        id: tc.id,
        vars: sortedVars(tc.vars),
        criteria: tc.criteria,
      })),
  });
  return hashContent(canonical);
}

/**
 * Stable fingerprint of judge+prompt+eval config — the strict-comparability
 * key. Includes the judge CLI version: a CLI upgrade can change judging
 * behavior (new default snapshot, new system prompt), so runs across an
 * upgrade are a regime change, not a comparable series.
 */
export function computeComparisonFingerprint(
  judgeProvider: string,
  judgeModel: string,
  judgeVersion: string | undefined,
  judgePromptHash: string,
  evalHash: string,
): string {
  return hashContent(
    `${judgeProvider}:${judgeModel}:${judgeVersion ?? "unknown"}:${judgePromptHash}:${evalHash}`,
  );
}

/** Builds the full provenance record for a comparison run over the given eval file. */
export function buildProvenance(evalFile: EvalFile): RunProvenance {
  const judgeProvider = "claude";
  const judgeModel = resolveJudgeModel();
  const judgeVersion = getJudgeVersion();
  const judgePromptHash = getJudgePromptHash();
  const evalHash = getEvalHash(evalFile);
  return {
    runAt: new Date().toISOString(),
    repo: getRepoSlug(),
    gitSha: getGitSha(),
    judgeProvider,
    judgeModel,
    judgeVersion,
    judgePromptHash,
    evalHash,
    comparisonFingerprint: computeComparisonFingerprint(
      judgeProvider,
      judgeModel,
      judgeVersion,
      judgePromptHash,
      evalHash,
    ),
  };
}
