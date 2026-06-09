# Multi-Model Eval Comparison

This document explains how to use Executant's multi-model eval system to benchmark prompt templates across providers and interpret the results.

## Quick start

```bash
# Start the model server first
docker compose --profile qwen7b up -d

npm run eval -- \
  --models claude/sonnet,opencode/llama-qwen7b/qwen2.5-coder-7b \
  --output-json results/comparison.json \
  --output-csv results/comparison.csv \
  evals/judge-evaluation.eval.yaml
```

Run all evals in a single sweep:

```bash
docker compose --profile qwen7b --profile qwen14b --profile llama8b up -d
for f in evals/*.eval.yaml; do
  npm run eval -- \
    --models claude/sonnet,opencode/llama-qwen7b/qwen2.5-coder-7b \
    --output-csv "results/$(basename $f .eval.yaml).csv" \
    "$f"
done
```

## How it works

1. Each model listed in `--models` runs every test case in the eval file.
2. The same Claude judge (`eval/judge.ts`) scores every output — model identity is hidden from the judge to prevent bias.
3. Results are collected into an `EvalComparison` object and printed as a side-by-side terminal table.
4. If `--output-json` or `--output-csv` are set, the comparison is serialized to disk.

## Model target format

Models are specified as `provider/model`:

| String | Provider | Model |
|---|---|---|
| `claude/sonnet` | `claude` | `sonnet` |
| `claude/opus` | `claude` | `opus` |
| `opencode/llama-qwen7b/qwen2.5-coder-7b` | `opencode` | `llama-qwen7b/qwen2.5-coder-7b` |
| `opencode/llama-qwen14b/qwen2.5-coder-14b` | `opencode` | `llama-qwen14b/qwen2.5-coder-14b` |

The first `/` separates provider from model. Model names can contain slashes (e.g., `llama-qwen7b/qwen2.5-coder-7b`).

## Terminal output

```
judge-evaluation — 2 models compared

                    claude/sonnet   opencode/llama-qwen7b/qwen2.5-coder-7b
  clear-pass            3/3  100%        3/3  100%
  clear-fail            2/3   67%        3/3  100%
  injection             2/3   67%        2/3   67%
  ────────────────────────────────────────────────────────────────
  TOTAL                7/9   78%        8/9   89%
```

## JSON output format

The `--output-json` file contains the full `EvalComparison` object:

```json
{
  "evalName": "judge-evaluation",
  "templatePath": "evals/judge-evaluation.eval.yaml",
  "models": [
    { "provider": "claude", "model": "sonnet" },
    { "provider": "opencode", "model": "llama-qwen7b/qwen2.5-coder-7b" }
  ],
  "runs": [
    {
      "evalName": "judge-evaluation",
      "model": { "provider": "claude", "model": "sonnet" },
      "results": [
        {
          "caseId": "clear-pass",
          "output": "...",
          "criteria": [
            { "criterion": "Output is valid JSON", "pass": true, "reason": "..." }
          ],
          "passCount": 3,
          "failCount": 0
        }
      ],
      "totalPass": 7,
      "totalCriteria": 9
    }
  ],
  "comparisonTable": [
    {
      "caseId": "clear-pass",
      "scores": {
        "claude/sonnet": { "pass": 3, "total": 3, "pct": 1 },
        "opencode/llama-qwen7b/qwen2.5-coder-7b": { "pass": 3, "total": 3, "pct": 1 }
      }
    }
  ]
}
```

## CSV output format

The `--output-csv` file is **denormalized** — one row per criterion judgment per model. This format is optimized for pivot tables and charting tools.

### Columns

| Column | Description |
|---|---|
| `eval_name` | Name of the eval (from the `.eval.yaml` `name:` field) |
| `template_path` | Absolute path to the prompt template `.txt` file |
| `case_id` | Test case identifier |
| `criterion` | The natural-language criterion being judged |
| `model_label` | Display label (`provider/model`, or custom `label:` if set) |
| `provider` | `claude` or `opencode` |
| `model` | Model name as passed to the CLI |
| `pass` | `true` or `false` |
| `reason` | Judge's reasoning for the pass/fail verdict |

### Example rows

```csv
eval_name,template_path,case_id,criterion,model_label,provider,model,pass,reason
"judge-evaluation","evals/judge-evaluation.eval.yaml","clear-pass","Output is valid JSON","claude/sonnet","claude","sonnet","true","Response is well-formed JSON"
"judge-evaluation","evals/judge-evaluation.eval.yaml","clear-pass","Output is valid JSON","opencode/llama-qwen7b/qwen2.5-coder-7b","opencode","llama-qwen7b/qwen2.5-coder-7b","true","JSON parses without error"
```

### Pivot table recipe (Excel / Google Sheets)

1. Import the CSV.
2. Insert pivot table. Rows: `case_id`. Columns: `model_label`. Values: `COUNT(pass)` filtered to `pass=true` / `COUNT(pass)` → gives pass rate per case per model.
3. Add a slicer on `eval_name` to compare evals side by side.

### Chart recipe

Plot `model_label` on X axis, `pct = pass / total_per_model` on Y axis, grouped by `eval_name`. This gives a quick overview of relative model performance across prompt templates.

## Adding a new model

Any provider supported by Executant can be added to a comparison run:

```bash
npm run eval -- \
  --models claude/sonnet,claude/opus,opencode/llama-qwen7b/qwen2.5-coder-7b \
  evals/plan-decompose.eval.yaml
```

To add a new provider type, implement `src/tasks/<provider>.ts` (following `opencode.ts`) and add a case to `src/tasks/agent.ts`.

## Caveats

- **Judge model is always Claude.** The judge (`eval/judge.ts`) always uses Claude regardless of the `--models` flag. This ensures consistent scoring across providers. The subject model (what generates the output) is what varies.
- **METHODOLOGY injection.** Claude steps receive the development methodology via `--append-system-prompt`. OpenCode steps do not, since OpenCode does not support this flag. This may affect scores on prompts that reward methodology-aware behavior.
- **Non-determinism.** Model outputs are non-deterministic. Re-running the same eval may yield slightly different scores. Run multiple times and average if you need stable benchmarks.

---

## Benchmark Comparison

Executant includes purpose-built evals for benchmarking coding agent quality across providers and models. These evals are designed to produce meaningful, differentiating data — not trivially easy tests that every model passes.

### Models Covered

| Label | CLI target | Notes |
|---|---|---|
| Claude Sonnet | `claude/sonnet` | Default Executant model |
| Claude Haiku | `claude/haiku` | Fastest Claude |
| ~~Claude Opus~~ | ~~`claude/opus`~~ | ~~Excluded from default run (cost)~~ |
| Qwen2.5 Coder 7B | `opencode/llama-qwen7b/qwen2.5-coder-7b` | Local via llama.cpp in Docker (~4.7 GB) |
| Qwen2.5 Coder 14B | `opencode/llama-qwen14b/qwen2.5-coder-14b` | Local via llama.cpp in Docker (~9 GB) |
| Llama 3.1 8B | `opencode/llama-llama8b/llama-3.1-8b` | Local via llama.cpp in Docker (~4.7 GB) |

### Benchmark Eval Dimensions

| Eval file | Dimension | Template | Cases |
|---|---|---|---|
| `code-generation-quality` | Can the model write correct, type-safe TypeScript from a spec? | `eval-code-generation.txt` | 3 |
| `instruction-following-precision` | Does the model honor every constraint in a multi-constraint prompt? | `eval-instruction-following.txt` | 3 |
| `structured-output-reliability` | Does the model produce `{`-first schema-conformant JSON reliably? | `eval-structured-output.txt` | 4 |
| `code-review-depth` | Does the model identify real non-trivial bugs vs. style observations? | `eval-code-review.txt` | 3 |
| `methodology-context-sensitivity` | Does METHODOLOGY system-prompt injection change behavior? | `dev-approach.txt` (reused) | 4 |

Plus the 5 existing evals that test Executant's internal prompts:
`development-methodology`, `self-healing-fix`, `judge-evaluation`, `plan-decompose`, `plan-judge`

### Running the Full Benchmark

```bash
# Run all evals × models, merge results, and generate a markdown report
npm run eval:compare

# Outputs:
#   results/<eval-name>.csv       one file per eval
#   results/comparison.csv        all results merged
#   results/comparison-report.md  Claude-written analysis

# To regenerate just the report from existing CSVs:
npm run eval:compare:report
```

### Running a Single Eval Against All Models

```bash
npm run eval -- \
  --models claude/sonnet,claude/haiku,opencode/llama-qwen7b/qwen2.5-coder-7b,opencode/llama-qwen14b/qwen2.5-coder-14b \
  --output-csv results/code-generation-quality.csv \
  evals/code-generation-quality.eval.yaml
```

### Methodology Sensitivity: What the 5th Eval Measures

The `methodology-context-sensitivity` eval uses the same `dev-approach.txt` template as the existing `development-methodology` eval, but with test cases specifically designed to expose the impact of TESTS FIRST and the verification sequence.

Claude receives the full development methodology via `--append-system-prompt METHODOLOGY`. OpenCode does not — this flag is unsupported. Comparing these two providers on this eval directly quantifies the value of structured methodology injection.

Expected pattern: Claude models should show higher pass rates on cases like `tests-first-explicit` and `verification-sequence` because the injected methodology explicitly instructs TESTS FIRST and names the four verification steps (lint, typecheck, test, build). OpenCode models respond purely from training data.

This is the most distinctive benchmark data point: *what does explicit methodology injection buy you, expressed as pass/fail criteria?*

### Pivot Table Recipe

1. Import `results/comparison.csv`.
2. Insert pivot table:
   - Rows: `case_id`
   - Columns: `model_label`
   - Values: `COUNTIF(pass, "true") / COUNTA(pass)` — gives pass rate per case per model
3. Add slicers on:
   - `eval_name` — filter to a single eval or compare across evals
   - `provider` — compare `claude` vs `opencode` in aggregate
4. For the methodology sensitivity chart: filter `eval_name = methodology-context-sensitivity`, then plot `model_label` on X axis and pass rate on Y axis to visualize the METHODOLOGY injection gap.
