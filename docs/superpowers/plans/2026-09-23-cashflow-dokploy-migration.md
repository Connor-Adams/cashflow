# Cashflow → Dokploy Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run cashflow (backend, frontend, Postgres, receipts storage) on `connor-host1` under Dokploy, verified on staging hostnames before the production domains move.

**Architecture:** Two Dokploy Applications (backend, frontend) plus a Dokploy Postgres service, in the existing `Cashflow` project (`Nf6O9I7racgxzQCF8A5Yq`). Images come from GHCR, already built by CI. Postgres moves by `pg_dump`/`pg_restore` over Railway's public endpoint. Receipts move from Railway object storage to Cloudflare R2. Verification happens on `*.rainbot.win` staging hostnames; production cutover is a Cloudflare repoint of the existing custom domains.

**Survey:** `docs/superpowers/specs/2026-09-23-cashflow-dokploy-survey.md`
**Env inventory:** `.superpowers/sdd/cashflow-env-inventory.md`

## Global Constraints

- Dokploy panel `http://192.168.2.88:3000`, header `x-api-key`, key in `$dokploy_key` from `~/.config/secrets/gv.env`. Cashflow project `Nf6O9I7racgxzQCF8A5Yq`.
- Box SSH is `root@192.168.2.88`; no other user works.
- **Never pipe binary through `railway ssh`** — it injects ANSI escapes and truncates long streams. It silently corrupted a telemetry tarball (65 MB source → 22 MB unreadable result). Postgres moves by `pg_dump` over the public endpoint and receipts move S3-to-S3, so neither needs that channel. If anything ever does, use `scripts/migrate-store.sh pull` from the telemetry repo.
- **Railway stays untouched and serving** until cutover is verified. It is the rollback.
- Secrets are never passed as CLI arguments and never echoed. Read them from Railway programmatically or store via `setkey`.
- Dokploy API shape traps, both already cost time on the telemetry job: services hang off `environments[]`, not the project root; and `project.one`'s nested application summaries return null for `domains`, `mounts`, `env` — use `application.one`.
- `application.update` **appends a suffix to `appName`**. Always re-read appNames after the update pass; the name you created is not the final one.
- Production hostnames must not resolve to the box until Task 9.

---

### Task 1: Create the Postgres service and restore the database

Doing data first means the backend has something to talk to the moment it starts, and its start-up migration can run against real data rather than an empty schema.

**Interfaces:** produces the Postgres appName and connection details consumed by Task 3's `DATABASE_URL`.

- [ ] **Step 1: Create a Postgres service in the Cashflow project**

Use `postgres.create` against environment id for project `Nf6O9I7racgxzQCF8A5Yq` (fetch it with `project.one`, reading `environments[0].environmentId`). Match the major version Railway runs — check first:

```bash
cd ~/Developer/cashflow && railway variables --service Postgres --json | python3 -c "import sys,json;print(json.load(sys.stdin).get('PGDATA'))"
```

```bash
cd ~/Developer/cashflow && railway ssh --service Postgres "sh -c 'postgres --version'" </dev/null
```

Expected: a major version. A restore into an older major will fail; into a newer one usually works but is worth knowing.

- [ ] **Step 2: Dump from Railway over the public endpoint**

`DATABASE_PUBLIC_URL` is the only externally reachable URL — the internal one is unusable off-platform.

```bash
cd ~/Developer/cashflow && railway variables --service Postgres --json | python3 -c "import sys,json;v=json.load(sys.stdin);print('has DATABASE_PUBLIC_URL:', bool(v.get('DATABASE_PUBLIC_URL')))"
```

Then dump without putting the URL on the command line:

```bash
cd ~/Developer/cashflow && DBURL=$(railway variables --service Postgres --json | python3 -c "import sys,json;print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])") && pg_dump --format=custom --no-owner --no-acl --file=/tmp/cashflow.dump "$DBURL" && ls -lh /tmp/cashflow.dump
```

Expected: a dump file in the low hundreds of MB (the volume is 357 MB including WAL and indexes).

- [ ] **Step 3: Verify the dump before trusting it**

A dump that restores cleanly but is missing tables is the failure worth catching here.

```bash
pg_restore --list /tmp/cashflow.dump | grep -c 'TABLE DATA'
```

Compare against the live table count:

```bash
cd ~/Developer/cashflow && DBURL=$(railway variables --service Postgres --json | python3 -c "import sys,json;print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])") && psql "$DBURL" -tAc "select count(*) from information_schema.tables where table_schema='public'"
```

Expected: the two counts agree. If they do not, stop — do not restore a partial dump.

- [ ] **Step 4: Restore into the Dokploy Postgres**

Copy the dump to the box and restore it from a container on `dokploy-network`, addressing Postgres by its appName. Verify row counts on a few of the largest tables against Railway afterwards — a restore that "succeeded" with zero rows in a table is the thing to catch.

- [ ] **Step 5: Confirm extensions and sequences survived**

```bash
psql "<dokploy url>" -tAc "select extname from pg_extension order by 1"
```

Expected: the same set Railway reports. Sequence values matter too — a reset sequence causes primary-key collisions on the first insert after cutover, which surfaces as a user-facing error hours later, not at restore time.

---

### Task 2: Migrate receipts to R2

Every receipt the user has uploaded lives in Railway's own object storage and does not travel with the app.

**Interfaces:** produces the R2 bucket name, endpoint and credentials consumed by Task 3's `AWS_*` variables.

- [ ] **Step 1: Measure what is there**

Source config, from the backend service: `AWS_ENDPOINT_URL=https://t3.storageapi.dev`, `AWS_S3_BUCKET_NAME=cashflow-receipts-vrkrwsp`, with `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION` / `AWS_S3_FORCE_PATH_STYLE` alongside.

Count objects and total size before choosing a copy method. Read the credentials from Railway into the environment rather than typing them.

- [ ] **Step 2: Create the R2 bucket**

Match the rainbot migration's setup: endpoint `https://3c2acd9cbcba5af09e4e5fcc96d062f6.r2.cloudflarestorage.com`, credentials already present as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. Name the bucket `cashflow-receipts`.

- [ ] **Step 3: Sync, then verify by count and by sample**

Use `aws s3 sync` with both endpoints. Afterwards confirm the object count matches, and fetch a handful of objects from both sides and compare checksums. Count alone does not prove the bytes arrived.

- [ ] **Step 4: Decide the key prefix**

`RECEIPTS_S3_KEY_PREFIX` is set on the backend. Keep it identical unless there is a reason to change it — the database stores keys relative to it, so a changed prefix orphans every existing receipt.

---

### Task 3: Create the backend Application

**Interfaces:** consumes Postgres from Task 1 and R2 from Task 2; produces the backend appName consumed by Task 4's staging domain.

- [ ] **Step 1: Create the Application and set its image**

`application.create` requires a non-empty `appName` — passing `""` fails validation. Supply `cashflow-backend-<rand6>`, then `application.update` with `{sourceType:"docker", dockerImage:"ghcr.io/connor-adams/cashflow-backend:main", registryId:"bqE2N807wr0m_kwUBLt_O"}`. Re-read the appName afterwards; the update appends a suffix.

Using the shared registry record keeps GHCR credentials in one place rather than inline on each app.

- [ ] **Step 2: Mount a volume at `/data`**

`docker-entrypoint.sh` chowns `RAILWAY_VOLUME_MOUNT_PATH`, defaulting to `/data`, before dropping to the `node` user. That variable will not exist on Dokploy, so it chowns a literal `/data`. `CSV_UPLOAD_DIR=/data/uploads/csv` and `RECEIPTS_UPLOAD_DIR=/data/uploads/receipts` both live under it.

Mount a Dokploy volume at exactly `/data` so the chown targets the real mount. Without this, the directories can end up root-owned while the process runs as `node`, and the first receipt upload fails with `EACCES` — a failure that surfaces in the UI, not at boot.

These paths are scratch, not durable storage — receipts land in R2 — but they must be writable.

- [ ] **Step 3: Set the environment, with staging values for the hostname-derived ones**

Carry across the 28 non-Railway variables currently on the Railway backend service, reading values programmatically so they are never echoed. Three take **staging** values for now and change at cutover:

| Variable | Staging value | Production value (Task 9) |
|---|---|---|
| `CORS_ORIGIN` | `https://cashflow.rainbot.win` | `https://cashflow.connoradams.ca` |
| `SESSION_COOKIE_DOMAIN` | `.rainbot.win` | `.cashflow.connoradams.ca` |
| `GOOGLE_OAUTH_REDIRECT_URI` / `_URL` | staging callback, or leave production | production callback |

Changes from Railway's set:

- `DATABASE_URL` → the Dokploy Postgres appName
- `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET_NAME` → R2
- `OTEL_EXPORTER_OTLP_ENDPOINT` → `http://telemetry-otel-collector-wyuddq-c1orqh:4318`
- **Drop `ALPHA_VANTAGE_API_KEY`** — dead; quotes go through a keyless Yahoo Finance client
- **Drop `NIXPACKS_BUILD_CMD` / `NIXPACKS_START_CMD`** — Railway builder configuration, meaningless here
- **Drop `DATABASE_PATH`** — the SQLite path; this deployment is Postgres-only
- Check `PGHOST` for redundancy against `DATABASE_URL` before carrying it

`EMAIL_INTEGRATION_ENCRYPTION_KEY` must carry across **unchanged** — it decrypts stored integration credentials, and a new value silently orphans them.

- [ ] **Step 4: Deploy and confirm migrations ran**

The image's `CMD` is `yarn run db:migrate && exec node dist/server.js`, so migrations run at container start against the restored database.

Check the logs for the migration output and a clean listen. Expected: migrations report nothing left to apply, since the restored dump already contains them. A long list of migrations running means the restore did not carry the `SequelizeMeta` table — stop and investigate.

---

### Task 4: Build and deploy the staging frontend

The frontend's API base is baked at build time, so a staging hostname needs its own image. This is the accepted cost of staging on `rainbot.win`.

- [ ] **Step 1: Build a staging image**

Trigger the frontend image build with `VITE_API_BASE=https://api-cashflow.rainbot.win` and tag it distinctly — `:staging`, never `:main`. Same commit, same Dockerfile; exactly one build arg differs from production.

- [ ] **Step 2: Create the frontend Application on the staging image**

Same creation pattern as Task 3 Step 1, pointing at the `:staging` tag.

- [ ] **Step 3: Attach staging domains**

`cashflow.rainbot.win` → frontend, and `api-cashflow.rainbot.win` → backend. Both need a Cloudflare public hostname added for the tunnel, the same way `grafana.rainbot.win` was — **Connor must do that part**; it is his Cloudflare account.

---

### Task 5: Verify on staging

- [ ] **Step 1: Backend health and database**

Confirm the API answers, reports healthy, and reads real data — check a couple of endpoints whose responses reflect the restored rows, not just a 200.

- [ ] **Step 2: Receipts round-trip against R2**

Upload a receipt through the app and fetch it back. This exercises `/data` writability (Task 3 Step 2's chown concern), the R2 credentials, and the key prefix together. Then confirm an **existing** receipt from before the migration still loads — that is what proves the bucket sync and the key prefix agree with what the database stores.

- [ ] **Step 3: Auth**

Sign in through the staging frontend. Cookies are scoped to `.rainbot.win` here; the production cookie domain is exercised only after cutover.

- [ ] **Step 4: Telemetry**

Confirm cashflow's logs and traces now arrive in the **new** Grafana at `grafana.rainbot.win`: query `{service_name="cashflow-backend"}` in Loki and look for `job="cashflow-backend"` on metrics — the label that proves `honor_labels: true` is doing its job.

This is the first time the extracted telemetry stack receives real traffic.

- [ ] **Step 5: Background jobs**

Confirm the schedulers start and at least one job completes. Note only 4–5 of roughly 14 jobs were confirmed to use the advisory-lock helper, so keep this at **one replica**.

- [ ] **Step 6: Known-inert features**

Do not raise these as migration regressions — they are pre-existing: email is `noop` (no `MAILER_*` is set on Railway either), and the in-app changelog is empty because `docs/` is not copied into the image.

---

### Task 6: Cutover

Only after Task 5 passes.

- [ ] **Step 1: Switch the frontend to the production image**

Point the frontend Application at `ghcr.io/connor-adams/cashflow-frontend:main` — the image with the production API base baked in. Redeploy.

- [ ] **Step 2: Switch the backend's three staging variables to production values**

`CORS_ORIGIN`, `SESSION_COOKIE_DOMAIN`, and the OAuth redirect URIs, per Task 3 Step 3's table. Redeploy.

- [ ] **Step 3: Attach the production domains in Dokploy**

`cashflow.connoradams.ca` → frontend, `api.cashflow.connoradams.ca` → backend. Traefik routes by Host header, so this is safe to do before DNS moves — nothing resolves here yet.

- [ ] **Step 4: Take a final Postgres delta**

Railway has been serving throughout, so it has accumulated writes since Task 1. Stop the Railway backend to freeze writes, re-dump, and restore over the Dokploy database.

This is the one genuinely destructive step. Confirm with Connor first, and state plainly that the app is down from this moment until DNS moves.

- [ ] **Step 5: Re-sync the receipts bucket**

Same reasoning — pick up anything uploaded since Task 2.

- [ ] **Step 6: Repoint DNS**

Move both hostnames in Cloudflare from Railway to the tunnel. **Connor's action.**

- [ ] **Step 7: Verify production**

Repeat Task 5's checks against the real hostnames: sign-in with the production cookie domain, an existing receipt loading, telemetry arriving, and the Google OAuth email integration — the one flow that could not be exercised on staging.

---

### Task 7: Decommission

**Destructive and irreversible. Do not begin without Connor's explicit confirmation, given per service.**

- [ ] **Step 1: Let it sit**

Leave Railway stopped but undeleted long enough to be confident. Rollback during this window is a DNS revert.

- [ ] **Step 2: Migrate the telemetry history**

Now that cashflow emits to the new stack, the telemetry data migration can proceed as a backfill with no time pressure — see the telemetry plan's Task 10. Re-pull the archives; the staged ones will be stale by then.

- [ ] **Step 3: Delete the Railway services and volumes**

Only after Connor approves each one by name.

---

## Verification Summary

- [ ] Postgres restored with matching table count, extensions and sequence values
- [ ] Receipts synced to R2, verified by count and by checksum sample
- [ ] Backend starts, migrations report nothing to apply
- [ ] A pre-existing receipt loads, proving bucket and key prefix agree with the database
- [ ] Auth works on the production cookie domain
- [ ] Telemetry reaches the new Grafana with `job="cashflow-backend"`
- [ ] Google OAuth email integration completes against the production callback
- [ ] Railway stopped but recoverable for the rollback window
