import type { EvalRun, TestResult } from './types.js';
import { theme } from '../ui/theme.js';

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];

// Terminal-only path — Ink is unavailable here, so convert theme hex values to ANSI directly
function hexToAnsi(hex: string): (s: string) => string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (s: string) => USE_COLOR ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s;
}

const color = (code: string) => (s: string): string =>
  USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;

const pass    = hexToAnsi(theme.success);
const fail    = hexToAnsi(theme.error);
const warning = hexToAnsi(theme.warning);
const accent  = hexToAnsi(theme.primary);
const dim     = color('2');

function scoreBar(passCount: number, total: number): string {
  const pct = total === 0 ? 0 : passCount / total;
  const bars = 10;
  const filled = Math.round(pct * bars);
  const bar = '█'.repeat(filled) + '░'.repeat(bars - filled);
  if (!USE_COLOR) return `${bar} ${passCount}/${total}`;
  const colorFn = pct === 1 ? pass : pct >= 0.5 ? warning : fail;
  return `${colorFn(bar)} ${passCount}/${total}`;
}

function printTestResult(result: TestResult): void {
  const icon = result.failCount === 0 ? pass('✓') : fail('✗');
  console.log(`  ${icon} ${accent(result.caseId)}  ${scoreBar(result.passCount, result.passCount + result.failCount)}`);

  for (const c of result.criteria) {
    if (c.pass) {
      console.log(`      ${pass('·')} ${dim(c.criterion)}`);
    } else {
      console.log(`      ${fail('·')} ${c.criterion}`);
      console.log(`          ${dim(c.reason)}`);
    }
  }
}

export function printRun(run: EvalRun): void {
  const allPass = run.totalPass === run.totalCriteria;
  const icon = allPass ? pass('✓') : fail('✗');
  console.log(`\n${icon} ${accent(run.evalName)}  ${scoreBar(run.totalPass, run.totalCriteria)}\n`);
  for (const result of run.results) {
    printTestResult(result);
    console.log();
  }
}

export function printRefinementHeader(iter: number, maxIter: number): void {
  console.log(`\n${accent(`[refine ${iter}/${maxIter}]`)} Running eval after refinement…`);
}

export function printRefinementSuccess(iter: number): void {
  console.log(pass(`\n✓ All criteria pass after ${iter} refinement iteration(s).`));
}

export function printRefinementExhausted(maxIter: number): void {
  console.log(fail(`\n✗ Max refinement iterations (${maxIter}) reached. Best version saved.`));
}

export function printDiff(original: string, refined: string): void {
  if (original === refined) {
    console.log(dim('\n(No changes made to template.)'));
    return;
  }
  const origLines = original.split('\n').length;
  const newLines = refined.split('\n').length;
  const delta = newLines - origLines;
  const sign = delta >= 0 ? '+' : '';
  console.log(dim(`\nTemplate updated: ${origLines} → ${newLines} lines (${sign}${delta})`));
}
