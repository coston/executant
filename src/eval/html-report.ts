// ============================================================================
// EVAL HTML REPORT
// ============================================================================
// Renders the eval history log as a single self-contained HTML file —
// leaderboards per eval (latest run per model) plus the full run history with
// regime-change markers, themed with the same @coston/design-tokens
// purple-dark theme the TUI uses (src/ui/theme.ts). The tokens are stored as
// CSS-native oklch() strings, so they are injected verbatim; no build step,
// no external stylesheet, script, or font — the file works offline as-is.
//
// Everything here is pure: history entries in, HTML string out. The only I/O
// lives at the `--html` flag in trend-index.ts.

import { createRequire } from "node:module";
import { formatDuration } from "../lib/utils.js";
import { buildTrends } from "./history.js";
import type { HistoryEntry, TrendGroup, TrendMode } from "./history.js";

const _require = createRequire(import.meta.url);
const { themes } = _require("@coston/design-tokens/tokens.json") as {
  themes: Record<string, Record<string, string>>;
};

const THEME_NAME = "purple-dark"; // the TUI's theme — keep the two in step

/** The design-token slots the report consumes, emitted as CSS custom properties. */
const TOKEN_KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
  "muted",
  "muted-foreground",
  "border",
  "success",
  "warning",
  "destructive",
  "chart-1",
  "chart-2",
  "radius",
] as const;

function themeCss(): string {
  const theme = themes[THEME_NAME]!;
  return TOKEN_KEYS.map((key) => `  --${key}: ${theme[key]};`).join("\n");
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtCost(costUsd: number | undefined): string {
  return costUsd !== undefined ? `$${costUsd.toFixed(4)}` : "—";
}

function fmtPct(pct: number): string {
  return `${Math.round(pct * 100)}%`;
}

/** Latest run per model within one eval, ranked by score, then by cost. */
function leaderboardRows(groups: TrendGroup[]): string {
  const latest = groups
    .map((g) => g.points.at(-1)!)
    .sort((a, b) => b.pct - a.pct || (a.costUsd ?? 0) - (b.costUsd ?? 0));

  return latest
    .map((point, i) => {
      const scoreClass = point.pct === 1 ? "score-full" : "";
      return `      <tr>
        <td class="rank">${i + 1}</td>
        <td class="model">${esc(point.modelLabel)}<span class="badge">${point.provider === "opencode" ? "LOCAL" : "API"}</span></td>
        <td class="score ${scoreClass}">
          <span class="bar" style="--w:${(point.pct * 100).toFixed(1)}%"></span>
          <span class="num">${point.passCount}/${point.totalCriteria}</span>
          <span class="num pct">${fmtPct(point.pct)}</span>
        </td>
        <td class="num">${esc(formatDuration(point.durationMs))}</td>
        <td class="num">${fmtCost(point.costUsd)}</td>
      </tr>`;
    })
    .join("\n");
}

/** One run history list per eval+model series, with regime-change markers. */
function historyRows(group: TrendGroup): string {
  return group.points
    .map((point) => {
      const marker = point.regimeChange
        ? `        <li class="regime">regime change — judge/prompt/eval fingerprint differs from previous run</li>\n`
        : "";
      const judge = `judge ${esc(point.judgeProvider)}/${esc(point.judgeModel)}${point.judgeVersion ? ` v${esc(point.judgeVersion)}` : ""} · fingerprint ${esc(point.comparisonFingerprint)}`;
      return `${marker}        <li title="${judge}">
          <span class="num when">${esc(point.runAt.slice(0, 16).replace("T", " "))}</span>
          <span class="num sha">${esc(point.gitSha?.slice(0, 7) ?? "unknown")}</span>
          <span class="num run-score${point.pct === 1 ? " score-full" : ""}">${point.passCount}/${point.totalCriteria} · ${fmtPct(point.pct)}</span>
          <span class="num">${fmtCost(point.costUsd)}</span>
          <span class="num">${esc(formatDuration(point.durationMs))}</span>
        </li>`;
    })
    .join("\n");
}

/**
 * A 10-bin score-distribution strip over each model's latest run — shows at a
 * glance whether the eval separates models or everyone clusters at a ceiling.
 * Pure CSS bars (no script) to keep the file self-contained; per-bin counts
 * live in title tooltips and every score is also in the table, so the strip
 * is a summary, never the sole carrier.
 */
function scoreHistogram(groups: TrendGroup[]): string {
  const latest = groups.map((g) => g.points.at(-1)!.pct);
  const bins = Array.from(
    { length: 10 },
    (_, i) =>
      latest.filter((p) => p >= i / 10 && (i === 9 ? p <= 1 : p < (i + 1) / 10))
        .length,
  );
  const max = Math.max(...bins, 1);
  const bars = bins
    .map((count, i) => {
      const h = count === 0 ? 0 : Math.max(18, (count / max) * 100);
      const label = `${i * 10}–${i * 10 + 10}%: ${count} model(s)`;
      return `<span class="hbar${count === 0 ? " empty" : ""}" style="--h:${h.toFixed(0)}%" title="${label}"></span>`;
    })
    .join("");
  return `      <div class="dist" role="img" aria-label="Distribution of latest model scores">
        <span class="muted label">score distribution</span>
        <div class="hist">${bars}</div>
      </div>`;
}

function evalSection(evalName: string, groups: TrendGroup[]): string {
  const runCount = groups.reduce((s, g) => s + g.points.length, 0);
  const series = groups
    .map(
      (g) => `      <details>
        <summary><span>${esc(g.modelLabel)}</span><span class="muted">${g.points.length} run(s)</span></summary>
        <ul class="runs">
${historyRows(g)}
        </ul>
      </details>`,
    )
    .join("\n");

  return `  <section class="card">
    <header class="split">
      <div>
        <h2>${esc(evalName)}</h2>
        <p class="muted">${groups.length} model(s) · ${runCount} recorded run(s). Ranked by the latest run per model; expand a series for its full history.</p>
      </div>
${scoreHistogram(groups)}
    </header>
    <div class="scroll">
      <table>
        <thead><tr><th>#</th><th>Model</th><th>Score</th><th>Duration</th><th>Cost</th></tr></thead>
        <tbody>
${leaderboardRows(groups)}
        </tbody>
      </table>
    </div>
${series}
  </section>`;
}

/**
 * Renders the full report. Groups the history by eval, one leaderboard card
 * per eval, each with expandable per-model run histories.
 */
export function renderHtmlReport(
  entries: HistoryEntry[],
  mode: TrendMode,
): string {
  const groups = buildTrends(entries, mode);
  const byEval = new Map<string, TrendGroup[]>();
  for (const group of groups) {
    const list = byEval.get(group.evalName);
    if (list) list.push(group);
    else byEval.set(group.evalName, [group]);
  }

  const sections =
    byEval.size > 0
      ? [...byEval.entries()]
          .map(([evalName, evalGroups]) => evalSection(evalName, evalGroups))
          .join("\n")
      : `  <section class="card"><p class="muted">No history records yet. Run evals with <code>--history</code> to start tracking.</p></section>`;

  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Executant Bench</title>
<style>
/* @coston/design-tokens · ${THEME_NAME} — the same theme as the TUI */
:root {
${themeCss()}
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.5rem 4rem;
  background: var(--background); color: var(--foreground);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.num, code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
main { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }
h1 { font-size: 1.6rem; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 1.15rem; margin: 0; }
.muted { color: var(--muted-foreground); }
.masthead p { margin: 0.35rem 0 0; }
.masthead .meta { display: flex; gap: 1.25rem; margin-top: 0.75rem; font-size: 0.82rem; }
.card {
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem;
}
.card header p { margin: 0.3rem 0 0; font-size: 0.85rem; }
header.split { display: flex; justify-content: space-between; align-items: flex-start; gap: 1.5rem; flex-wrap: wrap; }
.dist { display: flex; flex-direction: column; gap: 0.3rem; align-items: flex-end; }
.dist .label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; }
.hist { display: flex; align-items: flex-end; gap: 2px; height: 26px; width: 9rem; }
.hbar { flex: 1; border-radius: 1px 1px 0 0; background: var(--muted-foreground); opacity: 0.6; height: var(--h); }
.hbar.empty { height: 2px; opacity: 0.25; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th { text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-foreground); font-weight: 600; padding: 0 0.75rem 0.5rem 0; }
td { padding: 0.55rem 0.75rem 0.55rem 0; border-top: 1px solid var(--border); vertical-align: middle; }
td.rank { color: var(--muted-foreground); width: 2rem; }
td.model { font-weight: 600; }
.badge {
  margin-left: 0.5rem; padding: 0.1rem 0.4rem; border-radius: var(--radius);
  font-size: 0.65rem; letter-spacing: 0.05em; font-weight: 600;
  background: var(--muted); color: var(--muted-foreground);
}
td.score { min-width: 14rem; }
.bar {
  display: inline-block; vertical-align: middle; height: 6px; width: 7rem;
  border-radius: 3px; background: var(--muted); position: relative; margin-right: 0.6rem;
}
.bar::after {
  content: ""; position: absolute; inset: 0; width: var(--w);
  border-radius: 3px; background: var(--chart-1);
}
.score-full .bar::after, .run-score.score-full { background: var(--success); }
.run-score.score-full { background: none; color: var(--success); }
.pct { color: var(--muted-foreground); margin-left: 0.4rem; }
details { border-top: 1px solid var(--border); padding-top: 0.6rem; }
summary { cursor: pointer; display: flex; justify-content: space-between; font-size: 0.88rem; font-weight: 600; }
summary:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
ul.runs { list-style: none; margin: 0.6rem 0 0.2rem; padding: 0; font-size: 0.83rem; }
ul.runs li { display: flex; gap: 1.1rem; padding: 0.3rem 0; flex-wrap: wrap; }
ul.runs .when { color: var(--muted-foreground); }
ul.runs .sha { color: var(--primary); }
ul.runs li.regime { color: var(--warning); border-top: 1px dashed var(--warning); margin-top: 0.3rem; padding-top: 0.45rem; font-size: 0.78rem; }
footer { font-size: 0.78rem; }
</style>
</head>
<body>
<main>
  <header class="masthead">
    <h1>Executant Bench</h1>
    <p class="muted">Model comparison across executant's prompt-template evals, judged by LLM criteria.</p>
    <div class="meta muted">
      <span class="num">generated ${generatedAt} UTC</span>
      <span class="num">${entries.length} history record(s)</span>
      <span class="num">mode: ${mode}</span>
    </div>
  </header>
${sections}
  <footer class="muted">Generated by <code>executant eval:trend --html</code> from the eval history log. A score jump at a regime line is judge/eval drift, not model improvement.</footer>
</main>
</body>
</html>
`;
}
