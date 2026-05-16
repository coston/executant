export interface EvalTestCase {
  id: string;
  vars: Record<string, string>;  // resolved: file paths already read
  criteria: string[];
}

export interface EvalFile {
  name: string;
  prompt: string;          // resolved absolute path to .txt template
  placeholders: string[];  // {{PLACEHOLDER}} names expected in the template
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

export interface EvalArgs {
  evalFile: string;
  refine: boolean;
  maxIter: number;
}
