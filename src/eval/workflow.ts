// ============================================================================
// WORKFLOW EVAL HARNESS
// ============================================================================
// Runs executant workflow YAML tasks against multiple models in isolated git
// worktrees, then uses Claude to judge the resulting diff against eval_criteria.
//
// Two-phase design:
//   Phase 1 — Model execution: the model runs the workflow (explore → plan →
//             implement → test → commit). No self-evaluation.
//   Phase 2 — Harness evaluation: Claude reviews the git diff and judges it
//             against eval_criteria. The model never evaluates its own work.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDockerArgs, isDockerEnabled } from "./container.js";
import { load as parseYaml } from "js-yaml";
import { judgeAllCriteria } from "./judge.js";
import { modelLabel } from "./export.js";
import type {
  ModelTarget,
  WorkflowComparison,
  WorkflowEvalResult,
} from "./types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../..");
const INDEX_TS = join(REPO_ROOT, "src", "index.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

// ---------------------------------------------------------------------------
// Task file helpers
// ---------------------------------------------------------------------------

interface WorkflowEvalTask {
  taskName: string;
  taskGoal: string;
  criteria: string[];
}

/** Reads eval_criteria and goal from a workflow YAML file. */
function loadWorkflowEvalTask(filePath: string): WorkflowEvalTask {
  const raw = readFileSync(filePath, "utf8");
  const doc = parseYaml(raw) as Record<string, unknown>;
  const criteria = Array.isArray(doc["eval_criteria"])
    ? (doc["eval_criteria"] as string[])
    : [];
  const taskGoal =
    typeof doc["goal"] === "string" ? doc["goal"] : basename(filePath, ".yaml");
  const taskName = basename(filePath, ".yaml");
  return { taskName, taskGoal, criteria };
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

interface Worktree {
  path: string;
  /** SHA at the time the worktree was created — used to diff against after commits. */
  initialSha: string;
}

function createWorktree(model: ModelTarget, ts: number): Worktree {
  const slug = slugify(modelLabel(model));
  const worktreePath = join("/tmp", `eval-${slug}-${ts}`);
  const addResult = spawnSync(
    "git",
    ["worktree", "add", "--detach", worktreePath, "HEAD"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (addResult.status !== 0) {
    throw new Error(
      `Failed to create worktree at ${worktreePath}: ${addResult.stderr}`,
    );
  }

  // Capture HEAD SHA before the model makes any commits.
  const shaResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  const initialSha = shaResult.stdout.trim();

  // Symlink node_modules so npm test works without reinstalling.
  // In Docker mode this is skipped — node_modules are volume-mounted instead.
  const mainModules = join(REPO_ROOT, "node_modules");
  const worktreeModules = join(worktreePath, "node_modules");
  if (
    !isDockerEnabled() &&
    existsSync(mainModules) &&
    !existsSync(worktreeModules)
  ) {
    symlinkSync(mainModules, worktreeModules);
  }

  return { path: worktreePath, initialSha };
}

function removeWorktree(worktreePath: string): void {
  spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// Workflow execution
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  durationMs: number;
}

function runInWorktree(
  worktreePath: string,
  model: ModelTarget,
  taskAbsPath: string,
): Promise<RunResult> {
  const start = Date.now();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXECUTANT_PROVIDER: model.provider,
    EXECUTANT_MODEL: model.model,
  };

  return new Promise((res) => {
    // Run with --ci so executant emits NDJSON; filter to step lifecycle events
    // for a readable progress display without the full Ink TUI.
    //
    // Docker mode: spawn executant inside an isolated container so Claude/
    // OpenCode agents can only write to the worktree (/workspace) and cannot
    // touch the host filesystem outside it. The main repo is mounted read-only
    // as /app; node_modules are volume-mounted read-only at /workspace/node_modules.
    const child = isDockerEnabled()
      ? spawn(
          "docker",
          buildDockerArgs({
            workdir: worktreePath,
            readOnlyMounts: [
              { host: REPO_ROOT, container: "/app" },
              {
                host: join(REPO_ROOT, "node_modules"),
                container: "/workspace/node_modules",
              },
            ],
            env,
            cmd: [
              "node",
              "--import",
              "/workspace/node_modules/tsx/dist/esm.mjs",
              `/app/src/index.ts`,
              "--ci",
              `/app/${relative(REPO_ROOT, taskAbsPath)}`,
            ],
          }),
          { stdio: ["ignore", "pipe", "inherit"] },
        )
      : spawn(TSX_BIN, [INDEX_TS, "--ci", taskAbsPath], {
          cwd: worktreePath,
          env,
          stdio: ["ignore", "pipe", "inherit"],
        });

    // Print step-lifecycle progress lines
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            type: string;
            name?: string;
            durationMs?: number;
            error?: { message?: string };
          };
          if (event.type === "step:start" && event.name) {
            process.stdout.write(`    → ${event.name}\n`);
          } else if (event.type === "step:complete" && event.name) {
            const s = Math.round((event.durationMs ?? 0) / 1000);
            process.stdout.write(`    ✓ ${event.name} (${s}s)\n`);
          } else if (event.type === "step:error" && event.name) {
            process.stdout.write(
              `    ✗ ${event.name}: ${event.error?.message ?? "failed"}\n`,
            );
          }
        } catch {
          // non-JSON line — ignore
        }
      }
    });

    child.on("close", (code) => {
      res({ exitCode: code ?? 1, durationMs: Date.now() - start });
    });
  });
}

// ---------------------------------------------------------------------------
// Diff capture and stats
// ---------------------------------------------------------------------------

// Diff against the pre-run SHA so committed changes are included.
// Using "HEAD" would show nothing once the model's commit step runs.

function captureGitDiff(worktreePath: string, baseSha: string): string {
  const result = spawnSync("git", ["diff", baseSha, "--", "src/"], {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout ?? "";
}

function parseDiffStats(
  worktreePath: string,
  baseSha: string,
): WorkflowEvalResult["diffStats"] {
  const result = spawnSync("git", ["diff", "--stat", baseSha], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  const out = result.stdout ?? "";
  const match = out.match(
    /(\d+) file[s]? changed(?:, (\d+) insertion[s]?\(\+\))?(?:, (\d+) deletion[s]?\(-\))?/,
  );
  return {
    filesChanged: match ? parseInt(match[1] ?? "0", 10) : 0,
    insertions: match ? parseInt(match[2] ?? "0", 10) : 0,
    deletions: match ? parseInt(match[3] ?? "0", 10) : 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs a workflow eval task against each model in turn using isolated git
 * worktrees. After each run, Claude judges the git diff against eval_criteria.
 */
export async function runWorkflowEval(
  taskPath: string,
  models: ModelTarget[],
): Promise<WorkflowComparison> {
  const absTaskPath = resolve(taskPath);
  const { taskName, taskGoal, criteria } = loadWorkflowEvalTask(absTaskPath);
  const ts = Date.now();

  const results: WorkflowEvalResult[] = [];

  for (const model of models) {
    const label = modelLabel(model);
    console.log(`\n[${label}] Creating isolated worktree…`);

    const worktree = createWorktree(model, ts);
    mkdirSync(join(worktree.path, ".eval"), { recursive: true });

    try {
      console.log(`[${label}] Running workflow…`);
      const { exitCode, durationMs } = await runInWorktree(
        worktree.path,
        model,
        absTaskPath,
      );

      const testsPassed = exitCode === 0;
      console.log(
        `[${label}] Workflow ${testsPassed ? "✓" : "✗"} exit ${exitCode} (${Math.round(durationMs / 1000)}s)`,
      );

      const diff = captureGitDiff(worktree.path, worktree.initialSha);
      const diffStats = parseDiffStats(worktree.path, worktree.initialSha);
      const diffInput = diff
        ? `Task: ${taskGoal}\n\nGit diff (src/):\n\`\`\`diff\n${diff}\n\`\`\``
        : `Task: ${taskGoal}\n\n(No changes were made to src/)`;

      console.log(`[${label}] Judging ${criteria.length} criteria…`);
      const judgeResults = await judgeAllCriteria(diffInput, criteria);
      const judgePass = judgeResults.filter((r) => r.pass).length;
      console.log(
        `[${label}] Judge: ${judgePass}/${criteria.length} criteria pass`,
      );

      results.push({
        model,
        workflowExitCode: exitCode,
        testsPassed,
        judgeResults,
        diffStats,
        durationMs,
      });
    } finally {
      removeWorktree(worktree.path);
    }
  }

  return { taskPath: absTaskPath, taskName, taskGoal, criteria, results };
}
