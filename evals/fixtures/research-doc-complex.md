### Codebase Context

- **Project type**: TypeScript monorepo — `packages/api/` (Express), `packages/web/` (React), `packages/shared/` (types)
- **Entry points**: `packages/api/src/index.ts`, `packages/web/src/main.tsx`
- **Relevant files**:
  - `packages/api/src/models/` — Mongoose model definitions (User, Post, Comment)
  - `packages/api/src/routes/` — Express route handlers
  - `packages/api/src/middleware/auth.ts` — JWT authentication middleware
  - `packages/shared/src/types.ts` — shared TypeScript interfaces
  - `packages/web/src/components/` — React components
  - `packages/web/src/hooks/` — custom React hooks
- **Patterns**: Models use `mongoose.Schema`, routes use async/await with error boundaries, React components are functional with TypeScript generics
- **Tests**: Jest for API (`packages/api/src/__tests__/`), Vitest for web (`packages/web/src/__tests__/`)
- **Naming**: PascalCase for models/components, camelCase for functions, kebab-case for files

### Implementation Approach

Add user profile pages end-to-end:
1. Add `profilePicture` and `bio` fields to the User model
2. Create `GET /api/users/:id/profile` and `PUT /api/users/:id/profile` endpoints
3. Add shared types for profile data in `packages/shared/`
4. Create `ProfilePage` component and `useProfile` hook in `packages/web/`
5. Write API tests and component tests

Key decisions:
- Profile picture stored as URL string (not binary) — links to object storage
- Auth required for PUT, public for GET
- Use existing `auth.ts` middleware for protected routes
- Shared types ensure API and web stay in sync

### Step Breakdown

1. Add `profilePicture` (String, optional) and `bio` (String, optional) fields to User model in `packages/api/src/models/User.ts`
2. Add `UserProfile` interface to `packages/shared/src/types.ts`
3. Create `packages/api/src/routes/profile.ts` with GET and PUT handlers
4. Register the profile router in `packages/api/src/index.ts`
5. Create `useProfile` hook in `packages/web/src/hooks/useProfile.ts`
6. Create `ProfilePage` component in `packages/web/src/components/ProfilePage.tsx`
7. Write API tests in `packages/api/src/__tests__/profile.test.ts`
8. Write component tests in `packages/web/src/__tests__/ProfilePage.test.tsx`
9. Run API linter
10. Run API tests
11. Run web tests
12. Run TypeScript check across all packages

### Verification Plan

- Lint command: `npm run lint --workspace=packages/api`
- Test command (API): `npm test --workspace=packages/api`
- Test command (web): `npm test --workspace=packages/web`
- Build/typecheck command: `npm run typecheck`

### Risks & Notes

- Shared types must be updated BEFORE API or web code to avoid type errors
- User model migration: existing users will have undefined profilePicture/bio — handle gracefully with optional chaining
- Cross-step data flow: no output/context piping needed — each step targets specific known files
- Steps 9–12 are verification steps and should use `type: script`
- No hardcoded paths: all file paths must be declared in vars
