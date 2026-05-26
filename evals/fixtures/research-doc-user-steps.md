### Codebase Context

- **Project type**: New project (greenfield) — no existing codebase
- **Tech stack**: NextJS 14 (App Router), TypeScript, Prisma ORM, PostgreSQL, Resend (email), Vercel
- **Target structure**: `app/` (pages), `components/`, `prisma/schema.prisma`, `lib/`, `.github/workflows/`
- **Conventions**: kebab-case files, PascalCase components, camelCase functions
- **Tests**: Vitest for unit tests; Playwright for e2e
- **Verification**: `npm run lint`, `npm test`, `npm run build`

### Implementation Approach

Four user-specified steps form the backbone of this workflow. Each must map to exactly one workflow step:
1. Project scaffolding (NextJS + TypeScript + Prisma schema)
2. GitHub repo and CI setup
3. Core blog feature development
4. Final polish and deployment

Key decisions: `create-next-app` with TypeScript template, Prisma models (Post, Author, Tag),
GitHub Actions for CI, `next-mdx-remote` for MDX rendering, Resend SDK for transactional email.
Docker Compose for local PostgreSQL development (replaces cloud DB during dev).

### Step Breakdown

USER SPECIFIED 4 STEPS — PRESERVE STRUCTURE

**User Step 1 — Project Setup (NextJS + Prisma + PostgreSQL schema)**
- Scaffold NextJS 14 project with TypeScript using `create-next-app`
- Install Prisma and initialize (`npx prisma init`)
- Define Post, Author, Tag models in `prisma/schema.prisma`
- Create `docker-compose.yml` with a PostgreSQL service for local development
- Configure `DATABASE_URL` in `.env` and `.env.example`
- Run initial migration (`npx prisma migrate dev --name init`) and generate Prisma client
- Install additional deps: `next-mdx-remote`, `resend`, `next-themes`, `@types/node`
- Install dev deps: `vitest`, `@playwright/test`, `@testing-library/react`

**User Step 2 — GitHub Repo and CI Setup**
- Initialize git repo, create `.gitignore`, make initial commit
- Create GitHub repo via `gh repo create`, push initial commit, set remote origin
- Create `.github/workflows/ci.yml` running `npm run lint`, `npm run typecheck`, `npm test` on push to main
- Add `DATABASE_URL` to GitHub Actions secrets (use test DB URL or mock)

**User Step 3 — Core Blog Feature Development**
- Create post listing page (`app/page.tsx`) querying all published posts via Prisma
- Create individual post page (`app/posts/[slug]/page.tsx`) with MDX rendering via `next-mdx-remote`
- Create author profile page (`app/authors/[id]/page.tsx`) with author bio and post list
- Create tag filtering page (`app/tags/[tag]/page.tsx`) listing posts by tag
- Create shared components: PostCard, AuthorCard, TagBadge, Layout
- Create `lib/prisma.ts` singleton client and `lib/posts.ts` query helpers
- Write unit tests for lib helpers and component tests with Vitest + Testing Library
- Write Playwright e2e tests for post listing, individual post, author, and tag pages

**User Step 4 — Final Polish and Deployment**
- Integrate Resend SDK: create subscription API route (`app/api/subscribe/route.ts`), send confirmation email
- Add dark mode toggle using `next-themes` provider in root layout
- Add SEO metadata in root `layout.tsx` and per-page `generateMetadata()` functions
- Configure `vercel.json` and set environment variables in Vercel dashboard
- Deploy with `vercel --prod`
- Write e2e test for subscription flow

### Verification Plan

- Lint: `npm run lint`
- Test: `npm test`
- Build/typecheck: `npm run build`

### Risks & Notes

- User specified 4 steps — decomposer must create exactly 4 main workflow steps (hard constraint; do not split, merge, or reorder)
- Step 3 is intentionally large — it is one user-specified unit of work and must remain a single enriched step with detailed numbered sub-instructions
- Step 2 requires `GH_TOKEN` or `GITHUB_TOKEN` in the environment for `gh repo create`
- Docker Compose local dev: the `@coston/ui` package requirement from the user must be noted — install from GitHub in Step 1
- Cross-step data flow: no output/context piping needed between main steps; each step operates on known project files
- Verification steps (lint, test, build) should be appended after Step 4 as `type: script` steps
