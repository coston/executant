# Executant Benchmark Report

## Overview

- **Models compared:** 2 (claude/opus, claude/sonnet)
- **Eval covered:** 1 (`code-generation-quality`)
- **Test cases:** 3 (async-queue, retry-with-backoff, typed-event-emitter)
- **Total criteria judged:** 15 for opus (complete); 9 visible for sonnet (data truncated mid-run)

---

## Pass Rate by Model

| Model | Pass | Total | % |
|---|---|---|---|
| claude/opus | 13 | 15 | **86.7%** |
| claude/sonnet | 8 | 9 (visible) | **88.9%** *(incomplete)* |

*Sonnet data is truncated after retry-with-backoff criterion 4. typed-event-emitter results are absent — treat sonnet's rate as provisional.*

---

## Per-Eval Breakdown

| Case | Opus | Sonnet (visible) | Leader |
|---|---|---|---|
| async-queue | 4/5 (80%) | 4/5 (80%) | Tie |
| retry-with-backoff | 5/5 (100%) | 4/4 visible (100%) | Tie |
| typed-event-emitter | 4/5 (80%) | — | Opus only |

---

## Notable Findings

- **Both models failed the same async-queue criterion** — "class exported as default with no additional named exports." Both added `export interface QueueItem<T>` and `export interface AsyncQueue<T>` as named exports, suggesting a systematic over-sharing tendency when interfaces are relevant.
- **Opus failed the typed-event-emitter export criterion** — the spec asked for a named class export only; opus added `export default EventEmitter` anyway. Both failure types are "over-exporting" rather than missing required logic.
- **No functional logic failures** — every failure across both models was an export-shape violation, not a correctness issue. FIFO ordering, backoff math, generic types, and predicate handling were all implemented correctly.
- **Retry-with-backoff was a clean sweep** — 5/5 for opus and 4/4 visible for sonnet, the most complex case by spec, with no failures.
- **Data collection is incomplete** — with sonnet truncated at 9/15 criteria, cross-model comparison is not conclusive for this run.

---

## Recommendations

- **Use opus** when export shape precision matters (e.g., generating library code where named vs. default export is a public API contract). Even with its typed-event-emitter failure, it produced complete, analyzable results.
- **Use either model** for retry logic, backoff, and generics — both handled the full retry-with-backoff spec without errors.
- **Rerun the eval with sonnet** to collect the missing typed-event-emitter results before drawing final conclusions. The current gap makes the comparison unreliable.
- **Harden the eval prompt** for export shape — the consistent over-export failure across both models points to ambiguity in the spec wording, not model capability. Tightening the criterion description ("the file must contain exactly one export") should resolve it without model-level workarounds.