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
}

export interface EvalRun {
  evalName: string;
  templatePath: string;
  results: TestResult[];
  totalPass: number;
  totalCriteria: number;
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

/** Full multi-model comparison result for a single eval file. */
export interface EvalComparison {
  evalName: string;
  templatePath: string;
  models: ModelTarget[];
  runs: ModelEvalRun[];
  comparisonTable: ComparisonRow[];
}

export interface EvalArgs {
  evalFile: string;
  refine: boolean;
  maxIter: number;
  /** Models to compare. Empty array means "use Claude default" (single-model mode). */
  models: ModelTarget[];
  /** File path to write comparison JSON to (optional). */
  outputJson?: string;
  /** File path to write comparison CSV to (optional). */
  outputCsv?: string;
}
