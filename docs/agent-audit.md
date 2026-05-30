# Agent audit loop

This document describes how an AI agent (Claude or similar) can verify that the Cashflow backend is healthy after a deploy or configuration change.

## What the audit surface provides

Seven read-only HTTP probes, all behind a bearer token (`cfa_` prefix):

| Endpoint | What it checks |
|---|---|
| `GET /api/audit/health-deep` | DB reachability, migration status, uptime |
| `GET /api/audit/freshness` | Job last-run timestamps, import history, email integrations |
| `GET /api/audit/integrity` | Duplicate transactions, orphaned rows, unenriched transactions |
| `GET /api/audit/counts` | Row counts for all 12 core models |
| `GET /api/audit/client-errors` | Recent client-side errors (ring buffer, last N rows) |
| `GET /api/audit/server-errors` | Recent server 5xx errors (ring buffer, last N rows) |
| `GET /api/audit/route-probe` | Simulates each SPA page's API call and reports HTTP status |
| `GET /api/audit/summary` | Composite digest — `pass`/`warn`/`fail` per dimension + overall |

All endpoints return JSON. All are GET-only (non-GET returns 405).

## Authentication

Audit tokens are minted in **Settings → Audit tokens** (owner-only). They use the `cfa_` prefix and are SHA-256 hashed at rest — the plaintext is shown once at mint time.

Pass the token as a Bearer header:

```
Authorization: Bearer cfa_<32 base64url chars>
```

## Recommended agent loop

After a deploy (or on a schedule), the agent should:

1. Call `GET /api/audit/summary` and check `overall`.
   - `pass` → done, log green.
   - `warn` → inspect `dimensions` to find which dimension is degraded; log with details.
   - `fail` → escalate (create an issue, post to Slack, etc.).

2. If `health.verdict === 'fail'`: DB is unreachable or migrations are pending — this blocks everything else. Fix before proceeding.

3. If `routes.verdict === 'fail'`: check `dimensions.routes.summary` for which SPA pages are broken. The individual route results are in `GET /api/audit/route-probe`.

4. If `integrity.verdict !== 'pass'`: check `GET /api/audit/integrity` for counts of orphans/duplicates.

5. If `freshness.verdict !== 'pass'`: check `GET /api/audit/freshness` for stale or errored jobs.

## Example: post-deploy health check

```bash
TOKEN="cfa_..."
BASE="https://your-app.example.com"

RESULT=$(curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/api/audit/summary")
OVERALL=$(echo "$RESULT" | jq -r '.overall')

if [ "$OVERALL" = "pass" ]; then
  echo "Deploy healthy"
else
  echo "Deploy issue: $OVERALL"
  echo "$RESULT" | jq '.dimensions'
  exit 1
fi
```

## Scoping

Every probe is scoped to the household of the user who owns the token. There is no cross-household view.

## Ring buffer retention

Client and server error events are retained up to 5,000 and 2,000 rows respectively. The `audit_buffer_trim` nightly job (3:42 AM) trims both tables to those caps.

## Security

- Tokens are SHA-256 hashed at rest; the plaintext is never stored.
- All probes are GET-only; the middleware enforces this at the router level.
- Revoked tokens are rejected immediately (checked at request time).
- Ephemeral sessions created by `route-probe` have a 60-second TTL and are deleted in a `finally` block.
