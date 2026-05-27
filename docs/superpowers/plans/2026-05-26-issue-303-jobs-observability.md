# Jobs Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while executing. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an owner-accessible scheduled jobs observability dashboard with run history, manual run feedback, retention, and failure notifications.

**Architecture:** Add a generic `job_runs` ledger table/model because `ProviderJobLog` is not a scheduler-run history. Extend the existing runner and jobs API instead of adding a queue. Replace the Jobs settings tab with a polling operator table using the existing API helper style and Wander `Button`.

**Tech Stack:** Node/Express, Sequelize-style models/migrations, `tsx --test` backend tests, React/Vitest frontend tests, Tailwind v4 utilities, `@wandercom/design-system-web`.

---

### Task 1: JobRun Persistence

**Files:**
- Create: `backend/src/models/JobRun.ts`
- Create: `backend/src/migrations/20260604000002-create-job-runs.js`
- Create: `backend/test/migrations/jobRunsMigration.test.ts`
- Modify: `backend/src/models/index.ts`

- [ ] Write a migration test that verifies `job_runs` columns, `(job_name, started_at)` index, insert support, and reversible down migration.
- [ ] Run `yarn workspace cashflow-backend run test -- backend/test/migrations/jobRunsMigration.test.ts` and confirm it fails because the migration is missing.
- [ ] Add the migration and model, initialize/export `JobRun` from `backend/src/models/index.ts`.
- [ ] Re-run the migration test and confirm it passes.

### Task 2: Runner Ledger, Retention, Notifications

**Files:**
- Modify: `backend/src/jobs/runner.ts`
- Modify: `backend/src/jobs/types.ts`
- Modify: `backend/test/jobs/runner.test.ts`

- [ ] Add failing runner tests proving a run creates a `running` row, updates to `success`/`failed`, prunes old rows to 100, and enqueues one failure notification for an owner user when notification context is provided.
- [ ] Run `yarn workspace cashflow-backend run test -- backend/test/jobs/runner.test.ts` and confirm the new tests fail.
- [ ] Extend `tick()` with optional notification/auth context, create/update `JobRun`, prune older rows, and return `runId`/`queuedAt`.
- [ ] Re-run the runner test and confirm it passes.

### Task 3: Owner-Only Jobs API and History

**Files:**
- Modify: `backend/src/jobs/api.ts`
- Modify: `backend/src/jobs/registry.ts`
- Modify: `backend/test/integration/jobsApi.test.ts`

- [ ] Add failing integration tests for owner access, non-owner 403, `GET /api/jobs/:name/runs?limit=10` newest-first, and manual run 409 while running.
- [ ] Run `yarn workspace cashflow-backend run test -- backend/test/integration/jobsApi.test.ts` and confirm the new tests fail.
- [ ] Replace superadmin gate with owner gate, add the runs endpoint, pass request auth context into manual runs, and map already-running to 409 `JOB_ALREADY_RUNNING`.
- [ ] Re-run the jobs API test and confirm it passes.

### Task 4: JobsTab Operator Dashboard

**Files:**
- Modify: `frontend/src/types/jobs.ts`
- Modify: `frontend/src/pages/settings/tabs/JobsTab.tsx`
- Modify: `frontend/src/pages/settings/tabs/JobsTab.test.tsx`
- Inspect/modify only if needed: `frontend/src/pages/settings/SettingsPage.tsx`

- [ ] Add failing Vitest coverage for status pills, expanded history, run-now inline feedback/toast-equivalent text, disabled in-flight button, and auto-refresh toggle polling.
- [ ] Run `yarn workspace frontend run test -- JobsTab.test.tsx` or the repo-equivalent focused frontend test command and confirm the new tests fail.
- [ ] Update job types and rewrite `JobsTab` to fetch jobs and per-job runs, show expandable history, poll only when auto-refresh is enabled, and use Wander `Button`.
- [ ] Re-run the focused frontend test and confirm it passes.

### Task 5: Final Verification and PR

**Files:**
- All touched files

- [ ] Run focused backend/frontend tests from Tasks 1-4.
- [ ] Run `yarn workspace cashflow-backend run test`.
- [ ] Run `yarn workspace cashflow-backend run typecheck`.
- [ ] Run `yarn workspace frontend run tsc -b`.
- [ ] Run backend/frontend lint scripts if present.
- [ ] Commit without co-author trailers, push, create PR with `Closes #303`, enable auto-merge, then tend CI until merged.
