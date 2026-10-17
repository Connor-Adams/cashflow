# Cashflow → Dokploy: Migration Survey

**Date:** 2026-09-23
**Status:** Survey complete; plan not yet written
**Scope:** Moving the cashflow app (backend, frontend, Postgres, receipts storage) from Railway to `connor-host1`. The observability stack is a separate, already-executed piece of work — see `2026-09-23-telemetry-extraction-design.md`.

## Headline: this is smaller than it looks

Both public hostnames are **custom domains**, not Railway subdomains:

| Service | Hostname |
|---|---|
| frontend | `cashflow.connoradams.ca` |
| backend | `api.cashflow.connoradams.ca` |

Because they travel with the app, cutover is a **DNS repoint, not a reconfiguration**. Everything hostname-derived stays byte-identical:

- `VITE_API_BASE=https://api.cashflow.connoradams.ca` — baked into the frontend image at build time, so an unchanged hostname means **no image rebuild**
- `CORS_ORIGIN=https://cashflow.connoradams.ca`
- `SESSION_COOKIE_DOMAIN=.cashflow.connoradams.ca`
- `GOOGLE_OAUTH_REDIRECT_URI` / `..._URL` — **no Google Cloud console change**, which would otherwise have been a hard external dependency

That last point removes the only step that would have required Connor to reconfigure a third party under time pressure during cutover.

## Current state on Railway

Project `Cashflow Tracker`, eight services: `backend`, `frontend`, `Postgres`, plus the five telemetry services being retired separately.

Volumes — note what is **absent**:

| Volume | Service | Mount | Size |
|---|---|---|---|
| postgres-volume | Postgres | `/var/lib/postgresql/data` | 357 MB |

**The backend has no volume.** Receipts and CSVs are not stored on disk persistently; they go to object storage. `CSV_UPLOAD_DIR=/data/uploads/csv` and `RECEIPTS_UPLOAD_DIR=/data/uploads/receipts` are scratch paths on the ephemeral container filesystem.

## What actually has to move

### 1. Images — already built, already correct

`backend/Dockerfile` ends with:

```
CMD ["sh", "-c", "yarn run db:migrate && exec node dist/server.js"]
```

Migrations run at container start, so there is **no separate pre-deploy step to reproduce** on Dokploy. Both images are published to GHCR by `build-images.yml`, and the frontend's baked `VITE_API_BASE` is already right.

### 2. Postgres — 357 MB, dump and restore

`railway variables --service Postgres` exposes `DATABASE_PUBLIC_URL`; the internal URL is unusable from outside. `pg_dump` over the public endpoint into a Dokploy Postgres service. This is the method the rainbot migration already proved.

### 3. Receipts storage — the one genuinely new piece

```
AWS_ENDPOINT_URL=https://t3.storageapi.dev
AWS_S3_BUCKET_NAME=cashflow-receipts-vrkrwsp
```

That is **Railway's own object storage**, and it does not come with the app. Every receipt the user has uploaded lives there. This is the same Railway-bucket → Cloudflare R2 move the rainbot migration performed, and the R2 credentials (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`) are already present.

Unlike the telemetry volumes, this is S3-to-S3 and can be done with ordinary tooling — no `railway ssh` channel, so none of the corruption hazards that bit the telemetry migration apply.

### 4. Telemetry endpoint

`OTEL_EXPORTER_OTLP_ENDPOINT` currently points at `otel-collector.railway.internal:4318`. Once cashflow is on the box it becomes `http://telemetry-otel-collector-wyuddq-c1orqh:4318`, reachable over the shared `dokploy-network` — which is the whole reason cashflow must move before the telemetry history is migrated.

## Findings that would cause silent failure

Derived from reading the code, not the docs. The docs in this repo have been demonstrably stale.

**1. `docker-entrypoint.sh` chowns a Railway-specific path.** It chowns `RAILWAY_VOLUME_MOUNT_PATH` (defaulting to `/data`) before dropping to the `node` user. On Dokploy that variable will not be set, so it chowns a literal `/data` that may not be where anything is actually mounted. The upload and export directories can then end up owned by root while the process runs as `node`, producing `EACCES` on the first write — which surfaces as a failed receipt upload, not as a boot failure. Either mount the Dokploy volume at `/data` deliberately or adjust the script.

**2. `MAILER_DRIVER` defaults to `noop`.** Any partial or missing SMTP configuration silently falls back to logging only. No email is ever sent and nothing surfaces but a debug line. Note that no `MAILER_*` variable is set on Railway today either, so email is *already* inert in production — this is a pre-existing condition to be aware of, not a regression the migration introduces.

**3. `CHANGELOG_DIR` resolves to a path the image does not contain.** It defaults to `<backendRoot>/../docs/changelog`, but `backend/Dockerfile` never copies `docs/` in. The in-app "what's new" feature is permanently empty on a stock image build unless the variable is redirected. Also pre-existing.

**4. Stale documentation, confirmed again.** `.env.example` documents `ALPHA_VANTAGE_API_KEY`, `QUOTE_PROVIDER` and `QUOTE_DAILY_BUDGET` as the quote-fetch configuration. None of them appear anywhere in `backend/src` — quotes now go through a keyless Yahoo Finance client. `ALPHA_VANTAGE_API_KEY` is nonetheless still set on the Railway service, doing nothing.

## Ambiguity worth resolving before trusting the docs

The backend and frontend services both have `NIXPACKS_BUILD_CMD=yarn railway:build` and `NIXPACKS_START_CMD=yarn railway:start` set, which routes through `scripts/railway-run.cjs`. That is Railway's Nixpacks builder — a different path from the GHCR Docker images the README describes as the deployment mechanism.

This does not change the Dokploy plan, since we use the images either way and they are self-contained. But it means the README's account of how production is currently deployed may be wrong, and it should not be trusted as a reference for anything else during this migration.

## Environment configuration

Full inventory with `file:line` citations: `.superpowers/sdd/cashflow-env-inventory.md`.

Summary: 3 genuinely required (`EMAIL_INTEGRATION_ENCRYPTION_KEY`, `DATABASE_URL`, `SESSION_COOKIE_DOMAIN` for cross-subdomain cookies), ~15 that gate a feature silently when absent, ~45 optional with defaults, and 2 build-time `VITE_*`.

The 28 non-Railway variables currently set on the backend service are the operative set to carry across. `ALPHA_VANTAGE_API_KEY` can be dropped (dead). `PGHOST` is set alongside `DATABASE_URL` and should be checked for redundancy.

## Open questions

- **Do multiple replicas ever run?** Only 4–5 of roughly 14 background jobs were confirmed to use the Postgres advisory-lock helper. Single-replica on Dokploy is safe; scaling out later is not, without auditing the rest.
- **Do email or notification templates embed an absolute frontend URL?** Undetermined. Irrelevant while the hostname is unchanged, but it would matter if it ever changes.
- Whether the receipts bucket's object count and total size make a straight S3 sync practical — not yet measured.

## What needs Connor

- The DNS repoint for both hostnames at cutover, same mechanism as `grafana.rainbot.win`.
- A decision on the receipts bucket destination: Cloudflare R2 (matching rainbot) or something else.
