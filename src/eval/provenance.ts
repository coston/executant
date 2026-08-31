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
import { DEFAULT_MODEL } from "../lib/utils.js";
import type { EvalFile, RunProvenance } from "./types.js";

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

/** Hash of the judge prompt template — changes here signal a judging-regime change. */
function getJudgePromptHash(): string {
  const promptPath = join(__dir, "prompts", "criterion-judge.txt");
  return hashContent(readFileSync(promptPath, "utf8"));
}

/** Hash of the resolved eval spec (test cases + criteria) — changes here signal an eval-regime change. */
export function getEvalHash(evalFile: EvalFile): string {
  const canonical = JSON.stringify({
    name: evalFile.name,
    placeholders: [...evalFile.placeholders].sort(),
    testCases: [...evalFile.testCases]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((tc) => ({ id: tc.id, vars: tc.vars, criteria: tc.criteria })),
  });
  return hashContent(canonical);
}

/** Stable fingerprint of judge+prompt+eval config — the strict-comparability key. */
export function computeComparisonFingerprint(
  judgeProvider: string,
  judgeModel: string,
  judgePromptHash: string,
  evalHash: string,
): string {
  return hashContent(
    `${judgeProvider}:${judgeModel}:${judgePromptHash}:${evalHash}`,
  );
}

/** Builds the full provenance record for a comparison run over the given eval file. */
export function buildProvenance(evalFile: EvalFile): RunProvenance {
  const judgeProvider = "claude";
  const judgeModel = process.env["EXECUTANT_MODEL"] ?? DEFAULT_MODEL;
  const judgePromptHash = getJudgePromptHash();
  const evalHash = getEvalHash(evalFile);
  return {
    runAt: new Date().toISOString(),
    repo: getRepoSlug(),
    gitSha: getGitSha(),
    judgeProvider,
    judgeModel,
    judgeVersion: getJudgeVersion(),
    judgePromptHash,
    evalHash,
    comparisonFingerprint: computeComparisonFingerprint(
      judgeProvider,
      judgeModel,
      judgePromptHash,
      evalHash,
    ),
  };
}
