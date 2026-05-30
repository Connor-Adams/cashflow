# AI Audit Surface

The audit surface lets an AI agent (Claude, GPT-4, etc.) inspect the health of
a Cashflow instance without being granted a full interactive session. All
endpoints under `/api/audit/*` accept a **bearer `cfa_` token** and return
read-only diagnostic data.

## Authentication

1. In **Settings > AI Audit**, click **Mint audit token**.
2. Copy the `cfa_…` token — it is shown only once.
3. Store it as `CASHFLOW_AUDIT_TOKEN` in your agent's environment.
4. Pass it as an HTTP header on every request:

```
Authorization: Bearer cfa_<your-token>
```

Audit tokens are **GET-only** — the middleware returns `405 Method Not Allowed`
for any non-GET request. They cannot modify any data.

## Endpoints

| Path | Description |
|------|-------------|
| `GET /api/audit/_ping` | Liveness check — returns `{"ok":true}` |
| `GET /api/audit/integrity` | Duplicate groups, unenriched & orphaned transactions |
| `GET /api/audit/counts` | Per-model row counts for the household |
| `GET /api/audit/client-errors` | Recent frontend error ring-buffer |
| `GET /api/audit/server-errors` | Recent backend 5xx ring-buffer |
| `GET /api/audit/route-probe` | Ephemeral-session health probe of SPA API routes |
| `GET /api/audit/summary` | Composite verdict across all dimensions |
| `GET /api/audit/tokens` | (Session auth) List active audit tokens |
| `POST /api/audit/tokens` | (Session auth) Mint a new audit token |
| `DELETE /api/audit/tokens/:id` | (Session auth) Revoke a token |

### `GET /api/audit/integrity`

```json
{
  "duplicateGroups": { "count": 0, "extraRowCount": 0 },
  "unenrichedTransactions": 12,
  "orphanedTransactions": 0,
  "generatedAt": "2026-05-30T04:00:00.000Z"
}
```

### `GET /api/audit/counts`

```json
{
  "counts": {
    "transactions": 4821,
    "accounts": 7,
    "holdings": 23,
    "rules": 14,
    "contacts": 3,
    "externalOrders": 89,
    "subscriptions": 5,
    "goals": 2,
    "budgets": 8,
    "auditLog": 312,
    "chatThreads": 17,
    "aiSuggestions": 204
  },
  "generatedAt": "2026-05-30T04:00:00.000Z"
}
```

### `GET /api/audit/client-errors`

Query params: `since` (ISO timestamp), `level` (`error`|`warn`), `limit` (max 500).

```json
{
  "count": 3,
  "rows": [
    {
      "id": 42,
      "level": "error",
      "event": "unhandled_rejection",
      "message": "Cannot read property 'id' of null",
      "path": "/transactions",
      "requestId": null,
      "createdAt": "2026-05-30T03:47:11.000Z"
    }
  ]
}
```

### `GET /api/audit/server-errors`

Query params: `since` (ISO timestamp), `limit` (max 500).

```json
{
  "count": 1,
  "rows": [
    {
      "id": 7,
      "method": "GET",
      "path": "/api/transactions",
      "status": 500,
      "message": "column \"foo\" does not exist",
      "stack": "Error: ...",
      "requestId": "req_abc",
      "createdAt": "2026-05-30T03:44:01.000Z"
    }
  ]
}
```

### `GET /api/audit/route-probe`

Mints an ephemeral session (TTL 60 s) and probes each SPA page's backing API.

```json
{
  "routes": [
    { "page": "/", "apis": [{ "path": "/api/summary", "status": 200, "ok": true }], "ok": true },
    { "page": "/transactions", "apis": [{ "path": "/api/transactions?limit=1", "status": 200, "ok": true }], "ok": true }
  ],
  "generatedAt": "2026-05-30T04:00:00.000Z"
}
```

### `GET /api/audit/summary`

Query params: `windowMinutes` (default 60, max 1440).

```json
{
  "overall": "pass",
  "dimensions": {
    "health": { "verdict": "pass", "summary": "db 2ms" },
    "freshness": { "verdict": "pass", "summary": "8 jobs (0 errored, 0 stale > 24h)" },
    "integrity": { "verdict": "warn", "summary": "3 dupe groups (3 extra rows), 12 unenriched, 0 orphans" },
    "counts": { "verdict": "pass", "summary": "4821 txns, 7 accounts" },
    "clientErrors": { "verdict": "pass", "summary": "0 client errors in window" },
    "serverErrors": { "verdict": "pass", "summary": "0 server errors in window" },
    "routes": { "verdict": "pass", "summary": "13/13 pages green" }
  },
  "generatedAt": "2026-05-30T04:00:00.000Z"
}
```

## Verdicts

| Verdict | Meaning |
|---------|---------|
| `pass` | All checks green |
| `warn` | Degraded but not broken |
| `fail` | Action required |

## Ring-buffer retention

`client_error_events` and `server_error_events` rows older than **30 days** are
pruned daily by the `audit_buffer_trim` job (runs at 04:00 UTC).

## Security notes

- Audit tokens are stored as SHA-256 hashes; plaintext is shown only at mint time.
- Tokens are scoped to the minting user's household and cannot cross household boundaries.
- Each request touches `last_used_at` so stale tokens are visible in the UI.
- Revoke tokens in **Settings > AI Audit** when rotating credentials.
