# Agent Audit Surface

A read-only HTTP surface at `/api/audit/*` that lets an AI agent verify
Cashflow production is healthy after a deploy — without needing Loki or Grafana.

## Quick start

```bash
export CASHFLOW_BACKEND=https://backend-production-30f95.up.railway.app
export CASHFLOW_AUDIT_TOKEN=cfa_<your-token>

curl -s -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  $CASHFLOW_BACKEND/api/audit/summary | jq .
```

---

## 1. Mint a token

### Via settings UI

1. Open Cashflow → Settings → **AI audit tokens**.
2. Enter a label (e.g. `ci-bot`) and click **Mint token**.
3. Copy the revealed token — it is shown only once.
4. Store it as `CASHFLOW_AUDIT_TOKEN` in your agent's environment.

### Via API (fallback if UI hasn't deployed)

```bash
# Requires an active session cookie
curl -s -X POST \
  -H "Cookie: cashflow_session=<your-session>" \
  -H "Content-Type: application/json" \
  -d '{"label":"ci-bot"}' \
  $CASHFLOW_BACKEND/api/audit/tokens | jq .plaintext
```

---

## 2. Endpoint catalog

| Endpoint | What it tells you |
|---|---|
| `GET /api/audit/_ping` | Bearer token is valid and the server is up |
| `GET /api/audit/health-deep` | DB reachability, latency, pending migrations |
| `GET /api/audit/freshness` | Last-run timestamps for all jobs; import history; email-integration status |
| `GET /api/audit/integrity` | Duplicate transaction groups, orphaned rows, unenriched count |
| `GET /api/audit/counts` | Row counts for all major models (transactions, accounts, subscriptions, …) |
| `GET /api/audit/client-errors` | Recent frontend errors buffered in DB (`?since=ISO&level=error&limit=50`) |
| `GET /api/audit/server-errors` | Recent 5xx backend errors buffered in DB (`?since=ISO&limit=50`) |
| `GET /api/audit/route-probe` | Simulates each SPA page's on-mount API calls and reports ok/fail per route |
| `GET /api/audit/summary` | One-call composite digest with pass/warn/fail per dimension |
| `POST /api/audit/tokens` | *(session auth)* Mint a new audit token |
| `GET /api/audit/tokens` | *(session auth)* List active tokens |
| `DELETE /api/audit/tokens/:id` | *(session auth)* Revoke a token |

All probe endpoints (`_ping` through `summary`) accept **only GET** and require
`Authorization: Bearer cfa_<token>`. POST/PUT/DELETE return 405.

---

## 3. Agent loop pattern (recommended)

**Step 1 — call `/summary`**

```bash
curl -s -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  $CASHFLOW_BACKEND/api/audit/summary | jq '{overall, dimensions: (.dimensions | to_entries | map({key, verdict: .value.verdict, summary: .value.summary}))}'
```

If `overall == "pass"` → done.

**Step 2 — drill into failed dimensions**

For each dimension where `verdict != "pass"`, call the matching probe:

| Dimension | Probe endpoint |
|---|---|
| `health` | `/api/audit/health-deep` |
| `freshness` | `/api/audit/freshness` |
| `integrity` | `/api/audit/integrity` |
| `counts` | `/api/audit/counts` |
| `clientErrors` | `/api/audit/client-errors?since=<1h-ago>&limit=20` |
| `serverErrors` | `/api/audit/server-errors?since=<1h-ago>&limit=20` |
| `routes` | `/api/audit/route-probe` |

**Step 3 — fix and re-verify**

Apply the fix, then call `/summary` again. Repeat until `overall == "pass"`.

---

## 4. "Page won't load after deploy" diagnosis

Use this 5-step recipe when Connor reports a page is broken after a release:

```
1. GET /api/audit/summary
   → Check overall verdict and identify which dimension(s) are failing.

2. GET /api/audit/route-probe
   → Look for pages where ok == false. The `apis` array shows which
     backend call failed and the HTTP status + errorBody.

3. GET /api/audit/server-errors?since=<deploy-timestamp>&limit=20
   → Find 5xx errors that coincide with the deploy time.

4. GET /api/audit/client-errors?since=<deploy-timestamp>&level=error&limit=20
   → Find frontend JS errors that coincide with the deploy time.

5. GET /api/audit/health-deep
   → Confirm DB is reachable and no migrations are pending.
     Pending migrations cause 500s on routes that query new columns.
```

---

## 5. What this surface does NOT cover

- **Long-tail log search** — use Loki (`infra/grafana`) for grepping historical logs.
- **Trace-level debugging** — use Tempo for distributed traces.
- **Metrics dashboards** — use Grafana for time-series graphs.
- **Alert routing** — alerts fire via Grafana alerting (see `docs/observability.md`).

The audit surface is intentionally short-tail: it gives you the last 30 days
of ring-buffer events and the current state of jobs/DB/migrations. For anything
older, use Loki.

---

## 6. Revoke a token

### Via settings UI

Settings → AI audit tokens → click **Revoke** next to the token.

### Via API

```bash
curl -s -X DELETE \
  -H "Cookie: cashflow_session=<your-session>" \
  $CASHFLOW_BACKEND/api/audit/tokens/<token-id>
# Returns 204 No Content
```

---

## See also

- `docs/observability.md` — alert runbooks, Grafana/Loki/Tempo links
- `docs/superpowers/plans/2026-05-30-ai-audit-surface.md` — implementation plan
