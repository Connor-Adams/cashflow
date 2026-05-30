# Agent Audit Loop

The AI audit surface lets an AI agent (or a human shell user) verify that Cashflow is healthy after a deploy — without browser access or Loki/Grafana access. It exposes read-only, bearer-authenticated endpoints under `/api/audit/*`.

## 1. Mint a token

**Via the UI (preferred):** Settings → AI audit tokens → enter a label → Mint token. Copy the plaintext token shown once — it is never displayed again.

**Via the API (fallback if the UI hasn't loaded):**

```bash
# Replace $SESSION_COOKIE with a valid cashflow_session cookie value
curl -s -X POST https://backend-production-30f95.up.railway.app/api/audit/tokens \
  -H "Cookie: cashflow_session=$SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"label":"ci-agent"}' | jq .
# Response: { "id": 1, "label": "ci-agent", "token": "cfa_...", "createdAt": "..." }
```

## 2. Store the token

```bash
export CASHFLOW_AUDIT_TOKEN="cfa_..."
export CASHFLOW_BACKEND="https://backend-production-30f95.up.railway.app"
```

## 3. Endpoint catalog

| Endpoint | What it tells you |
|---|---|
| `GET /api/audit/_ping` | Liveness check — returns `{ok: true}` if the server process is alive |
| `GET /api/audit/health-deep` | DB reachability + latency, applied vs pending migrations, uptime |
| `GET /api/audit/freshness` | Job heartbeats (last run, last status, stale > 24h), import recency, email integration state |
| `GET /api/audit/integrity` | Duplicate transaction groups, orphaned transactions, unenriched transaction count |
| `GET /api/audit/counts` | Per-model row counts for the caller's household (transactions, accounts, rules, etc.) |
| `GET /api/audit/client-errors` | Recent frontend errors buffered from `/api/client-logs` (error + warn only); supports `?since=ISO&level=error&limit=100` |
| `GET /api/audit/server-errors` | Recent 5xx errors from the Express error handler; supports `?since=ISO&limit=100` |
| `GET /api/audit/route-probe` | Per-SPA-page on-mount API health — runs each page's GET calls in-process with an ephemeral session |
| `GET /api/audit/summary` | Composite worst-of digest across all dimensions; supports `?windowMinutes=N` (1–1440, default 60) |

All endpoints:
- Accept `Authorization: Bearer $CASHFLOW_AUDIT_TOKEN`
- Only respond to `GET` (non-GET returns 405)
- Scope data to the token owner's household

## 4. Recommended agent loop

**Step 1 — call summary:**

```bash
curl -s "$CASHFLOW_BACKEND/api/audit/summary" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq .
```

Inspect `overall`: if `"pass"`, you're done. If `"warn"` or `"fail"`, note the failing `dimensions.*` keys.

**Step 2 — drill into the failing dimension:**

```bash
# Example: freshness failed
curl -s "$CASHFLOW_BACKEND/api/audit/freshness" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq .jobs

# Example: routes failed
curl -s "$CASHFLOW_BACKEND/api/audit/route-probe" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq '.routes[] | select(.ok == false)'
```

**Step 3 — fix, redeploy, re-call summary.**

## 5. "Page won't load after deploy" diagnosis

Use this recipe when Connor reports "a page has an error at the top":

```bash
# 1. Get the digest
curl -s "$CASHFLOW_BACKEND/api/audit/summary" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq '{overall, routes: .dimensions.routes, serverErrors: .dimensions.serverErrors, clientErrors: .dimensions.clientErrors}'

# 2. If routes.verdict = "fail", find the broken page
curl -s "$CASHFLOW_BACKEND/api/audit/route-probe" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq '.routes[] | select(.ok == false)'

# 3. Get recent server errors (last 15 min)
curl -s "$CASHFLOW_BACKEND/api/audit/server-errors?since=$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)&limit=20" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq '.rows[] | {status, path, message}'

# 4. Get recent client errors (last 15 min)
curl -s "$CASHFLOW_BACKEND/api/audit/client-errors?since=$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)&level=error&limit=20" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq '.rows[] | {path, event, message}'

# 5. Check for pending migrations (common cause of 500s after a backend deploy)
curl -s "$CASHFLOW_BACKEND/api/audit/health-deep" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq '.migrations'
```

## 6. What this surface does NOT cover

- **Log tail / full-text search** — use Loki (`https://grafana.railway.internal`, query `{app="cashflow-backend"}`)
- **Latency histograms / p99** — use Grafana dashboards backed by the OpenTelemetry metrics pipeline; see `docs/observability.md`
- **Distributed traces** — use Tempo; see `docs/observability.md`
- **Business KPIs** (spend by category, etc.) — these are household data, not health signals

## 7. Revoke a token

**Via the UI:** Settings → AI audit tokens → Revoke next to the token.

**Via the API:**

```bash
# First, list tokens to find the ID
curl -s "$CASHFLOW_BACKEND/api/audit/tokens" \
  -H "Cookie: cashflow_session=$SESSION_COOKIE" | jq '.[] | {id, label}'

# Then revoke by ID (session auth, not bearer)
curl -s -X DELETE "$CASHFLOW_BACKEND/api/audit/tokens/1" \
  -H "Cookie: cashflow_session=$SESSION_COOKIE"
```

After revocation, any request with that bearer token returns 401.

## Self-test

Run this to verify the doc matches reality against local dev:

```bash
export CASHFLOW_BACKEND="http://localhost:3001"
# Mint a token via the UI or the API above, then:
export CASHFLOW_AUDIT_TOKEN="cfa_..."

# Liveness
curl -sf "$CASHFLOW_BACKEND/api/audit/_ping" | jq .
# Expected: {"ok":true}

# Summary
curl -sf "$CASHFLOW_BACKEND/api/audit/summary" \
  -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" | jq '{overall, generatedAt}'
# Expected: overall in ["pass","warn","fail"], generatedAt is an ISO string
```
