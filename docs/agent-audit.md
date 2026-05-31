# Agent Audit Surface

The audit surface is a read-only API that lets an AI agent (or a human operator) inspect the health and state of a Cashflow household without a session cookie. All endpoints require a `cfa_` bearer token minted from the Settings → Audit Tokens tab.

## Authentication

```
Authorization: Bearer cfa_<32-char-token>
```

Tokens are GET-only: any non-GET request to `/api/audit/**` returns `405 Method Not Allowed`. Cross-type tokens (e.g. `cfc_` capture tokens) are rejected with `403`.

Tokens are created via the session-authenticated endpoint `POST /api/audit/tokens`.

## Endpoints

### `GET /api/audit/_ping`
Liveness check. Always returns `{ "ok": true }` if the server is up and the token is valid.

### `GET /api/audit/counts`
Per-primitive row counts scoped to the household.

```json
{ "Transaction": 1234, "Account": 5, "Rule": 42, "Category": 18,
  "Subscription": 7, "PlannedEvent": 3, "FinancialGoal": 2,
  "generatedAt": "..." }
```

### `GET /api/audit/integrity`
Duplicate groups, unenriched transactions, and orphaned transactions for the household.

```json
{ "duplicateGroups": [], "unenrichedTransactions": 0, "orphanedTransactions": 0 }
```

### `GET /api/audit/health-deep`
DB connectivity (round-trip latency) and last applied migration.

```json
{ "db": { "ok": true, "latencyMs": 8 },
  "migrations": { "ok": true, "lastApplied": "20260610000001-..." },
  "generatedAt": "..." }
```

### `GET /api/audit/freshness`
Job heartbeats and most recent import timestamp.

```json
{
  "jobs": [
    { "name": "weeklyDigest", "lastRunAt": "...", "lastStatus": "ok", "ageSeconds": 3600 }
  ],
  "imports": { "lastImportAt": "...", "ageSeconds": 86400 },
  "generatedAt": "..."
}
```

### `GET /api/audit/client-errors`
Recent client-side errors buffered in memory (max 200, scoped to household).

### `GET /api/audit/server-errors`
Recent server 5xx errors buffered in memory (max 200, scoped to household).

### `GET /api/audit/route-probe`
DB-level health check for each major data domain (Account, Transaction, Rule, etc.).

### `GET /api/audit/summary`
Composite digest: counts + integrity + error counts in a single call.

## Agent Loop Pattern

A typical agent audit loop:
1. Call `/_ping` to confirm the token is valid and the server is reachable.
2. Call `/counts` to verify expected row counts.
3. Call `/integrity` to check for data quality issues.
4. Call `/health-deep` to verify DB and migration state.
5. Call `/freshness` to confirm jobs are running and data is being imported.
6. Call `/client-errors` and `/server-errors` for recent error details.
7. Call `/summary` for a single-call snapshot at the end.

## Token management

Tokens are created and revoked from **Settings → Audit Tokens** in the Cashflow UI, or via:
- `POST /api/audit/tokens` — mint a new token (returns plaintext once)
- `GET /api/audit/tokens` — list non-revoked tokens (hashes only, not plaintexts)
- `DELETE /api/audit/tokens/:id` — soft-revoke a token

## Buffer trim

The `audit_buffer_trim` nightly job (3:00 AM UTC) clears both in-memory error buffers. In-memory data is process-scoped and does not persist across restarts.
