### Codebase Context

- **Project type**: TypeScript Node.js application (`src/`)
- **Entry point**: `src/index.ts`
- **Relevant files**:
  - `src/middleware/` — contains existing Express middleware
  - `src/routes/` — API route handlers (`users.ts`, `posts.ts`, `auth.ts`)
  - `src/app.ts` — Express app setup, where middleware is registered
  - `src/tests/` — test suite using Node's built-in test runner
- **Patterns**: Middleware registered in `src/app.ts` via `app.use()`. Each route file exports a Router.
- **Naming**: kebab-case files, camelCase exports
- **Tests**: `src/tests/*.test.ts`, run via `npm test`

### Implementation Approach

Add a rate limiting middleware using the `express-rate-limit` package:
1. Install `express-rate-limit` as a production dependency
2. Create `src/middleware/rate-limit.ts` with a configured limiter instance
3. Register the middleware in `src/app.ts` before all route handlers
4. Write tests verifying the limiter rejects requests over the limit

Key decisions:
- Apply globally in `src/app.ts` rather than per-route, to avoid repetition
- Use window of 15 minutes, max 100 requests as sensible defaults
- No environment-specific config needed at this stage

### Step Breakdown

1. Install `express-rate-limit` package via npm
2. Create `src/middleware/rate-limit.ts` implementing the rate limiter
3. Register the rate limit middleware in `src/app.ts` before route registration
4. Write tests in `src/tests/rate-limit.test.ts` verifying limit enforcement
5. Run the linter to check code style
6. Run the test suite to verify everything passes
7. Run the TypeScript compiler to verify no type errors

### Verification Plan

- Lint command: `npm run lint`
- Test command: `npm test`
- Build/typecheck command: `npm run build`

### Risks & Notes

- `express-rate-limit` must be installed before the middleware file can be created
- Tests should use a low limit (e.g., 3 requests) to avoid needing many requests
- The middleware registration order in `src/app.ts` matters — rate limiting must come before routes
- No hardcoded paths: use vars for `src/middleware/rate-limit.ts`, `src/app.ts`, test file path
