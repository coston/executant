# Executant Benchmark Report

Let me read the actual results files to get the complete data before writing the report.Now I have complete data for both evals. Let me compile the numbers.I have all the data I need from reading the CSVs. Here is the report:

---

## Overview

**6 models** compared across **2 evals** (code-generation-quality, code-review-depth) covering **3 cases each** — 27 criteria per model, **162 total judgments**.

Models: `claude/opus`, `claude/sonnet`, `claude/haiku` (via Claude provider) and `opencode/qwen2.5-coder-7b`, `opencode/qwen2.5-coder-14b`, `opencode/llama-3.1-8b` (via OpenCode/Llama provider).

---

## Pass Rate by Model

| Model | Pass | Total | % |
|---|---|---|---|
| claude/sonnet | 24 | 27 | **88.9%** |
| claude/haiku | 24 | 27 | **88.9%** |
| claude/opus | 23 | 27 | 85.2% |
| opencode/qwen2.5-coder-7b | 20 | 27 | 74.1% |
| opencode/qwen2.5-coder-14b | 19 | 27 | 70.4% |
| opencode/llama-3.1-8b | 3 | 27 | 11.1% |

---

## Per-Eval Breakdown

**code-generation-quality** (15 criteria per model):

| Model | Pass | % |
|---|---|---|
| opencode/qwen2.5-coder-14b | 15/15 | **100%** |
| claude/sonnet | 14/15 | 93.3% |
| claude/haiku | 14/15 | 93.3% |
| opencode/qwen2.5-coder-7b | 14/15 | 93.3% |
| claude/opus | 13/15 | 86.7% |
| opencode/llama-3.1-8b | 1/15 | 6.7% |

qwen14b leads by a narrow 1-criterion margin over three tied runners-up.

**code-review-depth** (12 criteria per model):

| Model | Pass | % |
|---|---|---|
| claude/opus | 10/12 | **83.3%** |
| claude/sonnet | 10/12 | **83.3%** |
| claude/haiku | 10/12 | **83.3%** |
| opencode/qwen2.5-coder-7b | 6/12 | 50.0% |
| opencode/qwen2.5-coder-14b | 4/12 | 33.3% |
| opencode/llama-3.1-8b | 2/12 | 16.7% |

All three Claude models tie; all three OpenCode models fail to break 50%.

---

## Notable Findings

- **Code generation is easier than code review for local models.** qwen14b scores 100% on generation but only 33.3% on review — a 67-point collapse. qwen7b drops 43 points (93.3% → 50%). Claude models hold steady within 5 points across both evals.
- **Larger Qwen does not help on review.** qwen2.5-coder-14b scores *worse* on code-review-depth (4/12) than qwen2.5-coder-7b (6/12), despite being a bigger model. Both fail to identify the `recentPayloads` memory leak or the empty-Set leak after `off()`.
- **The `safeLimit` false-positive is a shared failure mode.** `claude/opus`, `claude/haiku`, and `opencode/qwen14b` all incorrectly flagged the safe `Math.min(Number(limit) || 10, 100)` pattern as a vulnerability. Only `claude/sonnet` and `opencode/qwen7b` passed this criterion.
- **The JS atomicity criterion exposes a reasoning disagreement.** Both `claude/opus` and `claude/sonnet` correctly analyzed single-threaded event-loop semantics and labeled the check-then-increment pattern safe — which the eval judged wrong. `claude/haiku` was the only Claude model to flag it as a real race, aligning with the eval's expected answer.
- **llama-3.1-8b is not viable.** It produced parse errors, permission rejections, and unrelated prose (GitHub PR status messages) instead of code or review output on 12 of 15 generation criteria and 10 of 12 review criteria.

---

## Recommendations

- **Production coding tasks (generation + review):** Use `claude/sonnet` or `claude/haiku` — they tie at 88.9% overall with identical review depth and better review reliability than Opus.
- **Code generation only, cost-sensitive, offline:** `opencode/qwen2.5-coder-7b` or `qwen2.5-coder-14b` are viable at 93–100% on generation. Budget for the 40–67 point review quality drop.
- **Security/correctness review specifically:** Require a Claude model. All three Claude models score 83.3% on code-review-depth vs. ≤50% for any local model.
- **Avoid `opencode/llama-3.1-8b`** for any structured coding task — systemic tool-use failures make it unreliable regardless of task type.