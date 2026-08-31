export interface EvalTestCase {
  id: string;
  vars: Record<string, string>; // resolved: file paths already read
  criteria: string[];
}

export interface EvalFile {
  name: string;
  prompt: string; // resolved absolute path to .txt template
  placeholders: string[]; // {{PLACEHOLDER}} names expected in the template
  testCases: EvalTestCase[];
}

export interface CriterionResult {
  criterion: string;
  pass: boolean;
  reason: string;
}

export interface TestResult {
  caseId: string;
  output: string;
  criteria: CriterionResult[];
  passCount: number;
  failCount: number;
  durationMs: number;
  /** API cost in USD for generating this case's output. Undefined when the provider doesn't report cost (e.g. OpenCode/local models). */
  costUsd?: number;
}

export interface EvalRun {
  evalName: string;
  templatePath: string;
  results: TestResult[];
  totalPass: number;
  totalCriteria: number;
  /** Sum of results[].costUsd. Undefined when no result reported a cost. */
  totalCostUsd?: number;
  /**
   * How many results came from a resumed --output-csv rather than running.
   * Non-zero blocks history appends: a cached score was produced under the
   * *old* run's provenance, so stamping it with a fresh one would fabricate
   * a trend point.
   */
  cachedCount?: number;
}

export interface FailureContext {
  caseId: string;
  vars: Record<string, string>;
  output: string;
  failedCriteria: CriterionResult[];
}

/** Identifies a provider+model combination for multi-model eval runs. */
export interface ModelTarget {
  provider: "claude" | "opencode";
  model: string;
  /** Display label. Defaults to "provider/model" at render time. */
  label?: string;
}

/** An EvalRun tagged with the model that produced it. */
export interface ModelEvalRun extends EvalRun {
  model: ModelTarget;
}

/** Per-case comparison row keyed by model label. */
export interface ComparisonRow {
  caseId: string;
  scores: Record<string, { pass: number; total: number; pct: number }>;
}

/**
 * Provenance metadata for a single eval-comparison run, captured so historical
 * trends stay interpretable: which repo/commit was evaluated, which judge
 * (model + prompt) scored it, and which eval spec was run. `comparisonFingerprint`
 * is a stable hash of judge+prompt+eval config — two runs only belong on the
 * same "strict comparable" trend line when it matches.
 */
export interface RunProvenance {
  runAt: string; // ISO timestamp
  repo?: string; // "owner/repo", when a GitHub remote is configured
  gitSha?: string; // commit evaluated
  judgeProvider: string;
  judgeModel: string;
  judgeVersion?: string; // judge CLI version, when it can be determined
  judgePromptHash: string;
  evalHash: string; // hash of the resolved eval spec (test cases + criteria)
  comparisonFingerprint: string; // hash of judgeProvider+judgeModel+judgePromptHash+evalHash
}

/** Full multi-model comparison result for a single eval file. */
export interface EvalComparison {
  evalName: string;
  templatePath: string;
  models: ModelTarget[];
  runs: ModelEvalRun[];
  comparisonTable: ComparisonRow[];
  provenance: RunProvenance;
}

export interface EvalArgs {
  /** One or more eval YAML file paths to run. */
  evalFiles: string[];
  /** Raw --cases filter string (comma-separated IDs or index ranges like "1-3"). */
  caseFilter?: string;
  refine: boolean;
  maxIter: number;
  /** Models to compare. Empty array means "use Claude default" (single-model mode). */
  models: ModelTarget[];
  /** File path to write comparison JSON to (optional). */
  outputJson?: string;
  /** File path to write comparison CSV to (optional). */
  outputCsv?: string;
  /** File path to append a JSONL history record to, for trend tracking (optional). */
  historyPath?: string;
}

// ---------------------------------------------------------------------------
// Workflow eval types (end-to-end agentic evaluation)
// ---------------------------------------------------------------------------

/** Per-criterion judgment result from a workflow eval run. */
export interface WorkflowEvalResult {
  model: ModelTarget;
  /** Exit code from running the executant workflow (0 = success). */
  workflowExitCode: number;
  /** True when the workflow completed with exit code 0. */
  testsPassed: boolean;
  /** Claude's judgment of the git diff against each eval criterion. */
  judgeResults: CriterionResult[];
  /** Stats from `git diff --stat HEAD`. */
  diffStats: { filesChanged: number; insertions: number; deletions: number };
  /** Wall-clock time for the workflow run in milliseconds. */
  durationMs: number;
}

/** Comparison of multiple models on a single workflow eval task. */
export interface WorkflowComparison {
  taskPath: string;
  taskName: string;
  taskGoal: string;
  criteria: string[];
  results: WorkflowEvalResult[];
}

/** Parsed CLI args for `npm run eval:workflow`. */
export interface WorkflowEvalArgs {
  taskFile: string;
  models: ModelTarget[];
  outputCsv?: string;
}
