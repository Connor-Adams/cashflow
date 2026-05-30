# Agent Audit Guide

The AI audit surface lets an AI agent (or a shell script) verify that Cashflow
is healthy after a deploy without needing a session cookie.  It is a set of
read-only HTTP endpoints protected by a `cfa_`-prefixed Bearer token.

---

## 1. Mint a token

**Via the UI (recommended)**

1. Open **Settings → AI audit tokens**.
2. Enter a label (e.g. `Deploy bot`) and click **Mint audit token**.
3. Copy the plaintext — it is shown once and never again.

**Via curl (fallback)**

```bash
# You must be logged in with a session cookie to mint
curl -s -c /tmp/cf_cookies.txt -b /tmp/cf_cookies.txt \
  -X POST https://backend-production-30f95.up.railway.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'

curl -s -b /tmp/cf_cookies.txt \
  -X POST https://backend-production-30f95.up.railway.app/api/audit/tokens \
  -H 'Content-Type: application/json' \
  -d '{"label":"Deploy bot"}'
# → {"id":1,"plaintext":"cfa_…","label":"Deploy bot","createdAt":"…"}
```

---

## 2. Store the token

Export two variables in your agent's environment:

```bash
export CASHFLOW_AUDIT_TOKEN="cfa_…"
export CASHFLOW_BACKEND="https://backend-production-30f95.up.railway.app"
```

Verify access:

```bash
curl -sf -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/_ping"
# → {"ok":true}
```

---

## 3. Endpoint catalog

| Endpoint | What it tells you |
|---|---|
| `GET /api/audit/_ping` | Token is valid and server is up |
| `GET /api/audit/health-deep` | DB reachability + latency, pending migrations |
| `GET /api/audit/freshness` | Job heartbeats, last import times, email integration status |
| `GET /api/audit/integrity` | Duplicate transaction groups, orphaned rows, unenriched count |
| `GET /api/audit/counts` | Row counts per model (transactions, accounts, rules, …) |
| `GET /api/audit/client-errors` | Recent browser-side errors persisted by the front-end log endpoint |
| `GET /api/audit/server-errors` | Recent 5xx errors captured by the error-tap middleware |
| `GET /api/audit/route-probe` | Per-SPA-page API health (ephemeral session, then cleaned up) |
| `GET /api/audit/summary` | Composite digest: one verdict per dimension + overall verdict |

All endpoints accept the `Authorization: Bearer <token>` header.
`/api/audit/summary` also accepts `?windowMinutes=N` (1–1440, default 60) to
control the lookback window for error counts.

---

## 4. Recommended agent loop

**Step 1 — call summary**

```bash
SUMMARY=$(curl -sf \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/summary")
echo "$SUMMARY" | jq '{overall, dimensions: (.dimensions | map_values(.verdict))}'
```

If `overall == "pass"`, you're done.

**Step 2 — drill into failed dimensions**

For each dimension where `verdict != "pass"`, call the matching detail endpoint:

| Dimension | Detail endpoint |
|---|---|
| `health` | `/api/audit/health-deep` |
| `freshness` | `/api/audit/freshness` |
| `integrity` | `/api/audit/integrity` |
| `counts` | `/api/audit/counts` |
| `clientErrors` | `/api/audit/client-errors?limit=50` |
| `serverErrors` | `/api/audit/server-errors?limit=50` |
| `routes` | `/api/audit/route-probe` |

**Step 3 — fix or escalate**

Use the detail payload to diagnose the root cause. If the agent can fix it
automatically (e.g. re-run a stale job, apply a migration), do so and
re-check. Otherwise surface the finding to the on-call human.

---

## 5. "Page won't load after deploy" recipe

1. **Call summary** — check `routes.verdict`. If `fail`, the broken page names
   are in `routes.summary`.
2. **Call route-probe** — find the failing `apis[]` entry. The `errorBody`
   field shows the raw API response.
3. **Call server-errors** — look for 5xx entries whose `path` matches the
   broken API and whose `stack` reveals the exception.
4. **Call client-errors** — look for JS errors (e.g. TypeError from a null
   API response) logged by the front-end.
5. **Call health-deep** — confirm the DB is reachable and no migration is
   pending; a missing migration is a common deploy-day failure.

---

## 6. What this surface does NOT cover

The audit surface covers application-layer health only.  For infrastructure
and observability, use:

- **Grafana** — dashboards for request rates, latency percentiles, error
  budgets, and DB pool metrics.
- **Loki** — full structured log search (filterable by `requestId`,
  `householdId`, log level).
- **Tempo** — distributed traces for slow or broken request paths.
- **Railway** — service restart history, resource consumption, deploy logs.

---

## 7. Revoke a token

**Via the UI:** Settings → AI audit tokens → **Revoke** next to the token row.

**Via curl:**

```bash
curl -sf -X DELETE \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/tokens/<id>"
```

The token is invalidated immediately; in-flight requests using it will receive
`401 Unauthorized` on the next call.

---

## Self-test

Run this after reading the doc to confirm it matches reality:

```bash
set -euo pipefail
BASE="${CASHFLOW_BACKEND:-https://backend-production-30f95.up.railway.app}"
TOKEN="${CASHFLOW_AUDIT_TOKEN:?set CASHFLOW_AUDIT_TOKEN first}"

ping=$(curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/api/audit/_ping")
echo "ping: $ping"

summary=$(curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/api/audit/summary")
overall=$(echo "$summary" | jq -r '.overall')
echo "overall: $overall"

dims=$(echo "$summary" | jq -r '.dimensions | to_entries[] | "\(.key): \(.value.verdict)"')
echo "$dims"

echo "Self-test passed."
```
