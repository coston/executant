# Multi-Model Eval Comparison

This document explains how to use Executant's multi-model eval system to benchmark prompt templates across providers, interpret the results, and produce white-paper-ready output.

## Quick start

```bash
npm run eval -- \
  --models claude/sonnet,opencode/opencode-go/kimi-k2.6 \
  --output-json results/comparison.json \
  --output-csv results/comparison.csv \
  evals/judge-evaluation.eval.yaml
```

Run all evals in a single sweep:

```bash
for f in evals/*.eval.yaml; do
  npm run eval -- \
    --models claude/sonnet,opencode/opencode-go/kimi-k2.6 \
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
| `opencode/opencode-go/kimi-k2.6` | `opencode` | `opencode-go/kimi-k2.6` |
| `opencode/opencode-go/deepseek-v4` | `opencode` | `opencode-go/deepseek-v4` |

The first `/` separates provider from model. Model names can contain slashes (e.g., `opencode-go/kimi-k2.6`).

## Terminal output

```
judge-evaluation — 2 models compared

                    claude/sonnet   opencode/opencode-go/kimi-k2.6
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
    { "provider": "opencode", "model": "opencode-go/kimi-k2.6" }
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
        "opencode/opencode-go/kimi-k2.6": { "pass": 3, "total": 3, "pct": 1 }
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
"judge-evaluation","evals/judge-evaluation.eval.yaml","clear-pass","Output is valid JSON","opencode/opencode-go/kimi-k2.6","opencode","opencode-go/kimi-k2.6","true","JSON parses without error"
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
  --models claude/sonnet,claude/opus,opencode/opencode-go/kimi-k2.6 \
  evals/plan-decompose.eval.yaml
```

To add a new provider type, implement `src/tasks/<provider>.ts` (following `opencode.ts`) and add a case to `src/tasks/agent.ts`.

## Caveats

- **Judge model is always Claude.** The judge (`eval/judge.ts`) always uses Claude regardless of the `--models` flag. This ensures consistent scoring across providers. The subject model (what generates the output) is what varies.
- **METHODOLOGY injection.** Claude steps receive the development methodology via `--append-system-prompt`. OpenCode steps do not, since OpenCode does not support this flag. This may affect scores on prompts that reward methodology-aware behavior.
- **Non-determinism.** Model outputs are non-deterministic. Re-running the same eval may yield slightly different scores. Run multiple times and average if you need stable benchmarks.
