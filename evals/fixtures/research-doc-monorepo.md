### Codebase Context

- **Project type**: TypeScript monorepo managed with npm workspaces
- **Packages**:
  - `packages/api` — Express REST API, `src/`, TypeScript
  - `packages/web` — React frontend, `src/`, TypeScript
  - `packages/shared` — Shared types and utilities, consumed by api and web
- **Root scripts**: `npm run lint` runs lint for all packages; `npm test` runs all tests; `npm run build` compiles all packages
- **Per-package scripts**: each package has its own `npm run lint`, `npm test`, `npm run build`
- **Patterns**: workspace packages are installed with `npm install -w packages/api` etc.
- **Tests**: `*.test.ts` in each package's `src/tests/`, run via `npm test` at root or per-package
- **Naming**: kebab-case files, camelCase exports

### Implementation Approach

Add a shared `logger` utility to `packages/shared` and integrate it into `packages/api` and `packages/web`:

1. Create `packages/shared/src/logger.ts` — a typed logger wrapping `pino`
2. Export it from `packages/shared/src/index.ts`
3. Update `packages/api/src/app.ts` to import and use the logger for request logging
4. Update `packages/web/src/main.tsx` to import and use the logger for client-side error logging
5. Write tests for the logger in `packages/shared/src/tests/logger.test.ts`
6. For each package: run lint, run tests, run build to confirm no regressions

### Step Breakdown

1. Install `pino` in `packages/shared`
2. Create the `Logger` class in `packages/shared/src/logger.ts`
3. Export the logger from `packages/shared/src/index.ts`
4. Integrate logger into `packages/api`
5. Integrate logger into `packages/web`
6. Write logger unit tests in `packages/shared`
7. For each workspace package (`packages/shared`, `packages/api`, `packages/web`): run lint, then run tests, then run build

### Verification Plan

- Lint command: `npm run lint` (root)
- Test command: `npm test` (root)
- Build/typecheck command: `npm run build` (root)
- Per-package verification: `npm run lint --workspace=packages/api`, `npm test --workspace=packages/api`, `npm run build --workspace=packages/api` (repeat for web and shared)
