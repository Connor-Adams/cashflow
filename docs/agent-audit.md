# Auditing cashflow from an AI agent

This document tells an AI agent (or a human shell user) how to verify the production cashflow deployment is healthy using the read-only audit surface.

## Get a token

1. Sign into the cashflow web app.
2. Go to **Settings → AI audit tokens**.
3. Click **Mint token**, give it a label (e.g. `ci-bot`), copy the `cfa_…` plaintext immediately. It will not be shown again.
4. Store it as an env var (locally, in CI, in your shell session — whatever fits).

```bash
export CASHFLOW_AUDIT_TOKEN="cfa_..."
export CASHFLOW_BACKEND="https://backend-production-30f95.up.railway.app"
```

## Endpoints

All audit endpoints are read-only (`GET`) and require `Authorization: Bearer $CASHFLOW_AUDIT_TOKEN`.

| Endpoint | What it tells you |
|---|---|
| `GET /api/audit/health-deep` | DB reachable + latency, pending migrations, version |
| `GET /api/audit/freshness` | Scheduler job heartbeats, last import per source, email-integration last scan |
| `GET /api/audit/integrity` | Duplicate transaction groups, FK orphans, unenriched count |
| `GET /api/audit/counts` | Row counts per major model |
| `GET /api/audit/client-errors?since=ISO&level=error` | Frontend errors logged via clientLogger |
| `GET /api/audit/server-errors?since=ISO` | Backend 5xx events in the last N minutes |
| `GET /api/audit/route-probe` | Per-SPA-page status: simulates the API calls each page makes |
| `GET /api/audit/summary?windowMinutes=60` | **Start here.** Composite digest with pass/warn/fail per dimension |

## Agent loop pattern

```bash
# 1. Smoke check after deploy
curl -sS -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/summary?windowMinutes=15" | jq

# 2. If overall != "pass", drill down on the failed dimension
curl -sS -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/route-probe" | jq '.routes[] | select(.ok == false)'

# 3. For frontend errors, check the buffer
curl -sS -H "Authorization: Bearer $CASHFLOW_AUDIT_TOKEN" \
  "$CASHFLOW_BACKEND/api/audit/client-errors?level=error&limit=20" | jq '.rows'
```

## "Page won't load after deploy" diagnosis

1. `GET /api/audit/summary` → look at `dimensions.routes.verdict`.
2. If `fail`, the `summary` field names the broken pages: e.g. `BROKEN: /transactions, /forecast`.
3. `GET /api/audit/route-probe` → for each broken page, look at `apis[].errorBody` to see the actual error.
4. `GET /api/audit/server-errors?since=<deploy_time>` → if the failing API is a 5xx, the buffered stack trace is there.
5. `GET /api/audit/client-errors?since=<deploy_time>` → if the page is throwing client-side, the captured error event names the file and line.

## What this surface does NOT cover

- **Loki / Grafana / Tempo** — query those directly for cross-service traces and log aggregation.
- **Histograms or rate-of-change** — every endpoint returns a single snapshot, not a time-series.
- **Mutations** — the audit surface is strictly read-only. The agent cannot retry a failed job or re-enrich data from here. Use the session-auth UI/API for that.

## Revoking a token

Go to **Settings → AI audit tokens → Revoke**. The token is soft-deleted (`revoked_at` set); subsequent calls return 401 within seconds.
