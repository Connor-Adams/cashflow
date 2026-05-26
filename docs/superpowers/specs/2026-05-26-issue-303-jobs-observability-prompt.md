# Issue 303 Jobs Observability Briefing

## Understand

Cashflow has code-defined scheduled jobs registered through `backend/src/jobs/registry.ts` and executed by `backend/src/jobs/runner.ts`. The `jobs` table stores only the latest state, while `ProviderJobLog` is provider-specific and cannot represent every scheduler run. Operators need an owner-accessible Settings -> Jobs view with last-run health, recent run history, manual run feedback, and polling.

## Challenge

The feature must not turn into a cron editor or queue system. Manual `POST /api/jobs/:name/run` currently runs synchronously, so the API can return a concrete `runId` and outcome without adding a separate queue. The existing re-entrancy guard in `runner.ts` is process-local and should become visible to the route as a 409 before a second manual run starts. Job failure notifications need a recipient; in the single-user/operator model, use owner users from the active household when an authenticated request exists, and otherwise skip notification delivery rather than inventing a global recipient.

## Synthesize

Add a generic `job_runs` table and `JobRun` model. The runner creates a `running` row when a real execution starts, updates it to `success` or `failed`, records skipped outcomes, and prunes to the latest 100 rows per job after each run. `GET /api/jobs` continues to list registered definitions and latest state; `GET /api/jobs/:name/runs?limit=10` returns newest-first run history; `POST /api/jobs/:name/run` returns 409 when the job is already running and otherwise runs immediately, returning `{ jobName, runId, queuedAt, status, durationMs, error? }`. Jobs routes become owner-only instead of superadmin-only. The frontend `JobsTab` should use the existing API helpers and Wander Button, render status pills/history, poll every 10s when auto-refresh is enabled, and keep the historical enable/reset controls only if they do not dominate the observability workflow.
