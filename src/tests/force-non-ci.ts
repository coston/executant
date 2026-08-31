// ============================================================================
// FORCE NON-CI ENVIRONMENT FOR INK RENDERING TESTS
// ============================================================================
// Ink checks the `is-in-ci` package once at module load, and when it detects a
// CI environment it defers all frame rendering: `onRender` stashes each frame
// in memory instead of writing it, and only the final frame is written at
// unmount. On top of that, the CI unmount path writes `lastOutput + "\n"` even
// in debug mode (where `lastOutput` is never populated), so a component that
// exits on its own overwrites its real final frame with a bare "\n". Either
// way, a test that asserts on frames written to a fake stdout sees nothing —
// which is exactly what happened on GitHub Actions (CI=true) while the same
// tests passed locally.
//
// `is-in-ci` computes, at module evaluation time:
//
//   env.CI !== '0' && env.CI !== 'false'
//     && ('CI' in env || 'CONTINUOUS_INTEGRATION' in env
//         || Object.keys(env).some(key => key.startsWith('CI_')))
//
// Setting CI="false" fails the first conjunct, which short-circuits the whole
// expression — so this guarantees "not CI" even on a real Actions runner where
// GITHUB_ACTIONS=true and CI_* variables are also set.
//
// IMPORTANT: this module must be the FIRST import of any test file that
// renders Ink (directly, via ink-testing-library, or via a `../ui/*`
// component, all of which import ink) — `is-in-ci` reads the env when its
// module evaluates, and ESM evaluates imports in listed order.

process.env["CI"] = "false";
