### Codebase Context

- **Project type**: TypeScript Node.js application (`src/`)
- **Entry point**: `src/index.ts`
- **Relevant files**:
  - `src/runner.ts` — workflow execution engine
  - `src/load-workflow.ts` — YAML → typed Workflow parser
  - `src/tests/` — test suite using Node's built-in test runner
- **Patterns**: CLI tool; steps run sequentially; quality gate uses LLM-as-judge
- **Tests**: `src/tests/*.test.ts`, run via `npm test`

### Task Analysis

Running "the codebase audit" repeatedly to surface flaky quality issues means repeating a single audit step N times. The audit itself is a single Claude prompt step that analyzes code quality. Repetition should be expressed using `repeat: N`, not by manually listing N separate steps.

### Implementation Approach

A single-step workflow with `repeat: 10` on the audit step:
1. One prompt step that performs the quality audit
2. `repeat: 10` on that step to run it 10 times
3. Each run uses `{{item}}` as the iteration counter (1–10)

Key decisions:
- Do NOT expand into 10 separate named steps — that is brittle and verbose
- Do NOT use `forEach` with a numeric array like `["1","2",...,"10"]` — that is the anti-pattern `repeat: N` was designed to replace
- `repeat: 10` compiles to a forEach at load time and is the correct declarative form

### Step Breakdown

1. Run the audit prompt with `repeat: 10` — each iteration gets `{{item}}` as pass number

### Verification Plan

No build/test commands needed — this is a pure prompt step workflow.

### Risks & Notes

- Ensure `repeat: 10` is used, not `forEach: ["1","2","3","4","5","6","7","8","9","10"]`
- The iteration variable `{{item}}` should be referenced in the prompt so each pass is labeled
- A single step with `repeat: 10` is correct; splitting into 10 steps is wrong
