# Deploying to Railway

Cashflow deploys to Railway as a single Yarn workspace monorepo with two
services. Both services point at the repo root and select their target via the
`RAILWAY_DEPLOY_TARGET` environment variable.

## Services

### Backend service

```
Root Directory:     /
Build Command:      yarn railway:build
Pre-deploy Command: yarn railway:migrate
Start Command:     yarn railway:start
Healthcheck Path:  /api/health
```

### Frontend service

```
Root Directory:    /
Build Command:     yarn railway:build
Start Command:     yarn railway:start
Healthcheck Path:  /
```

Do not set a Railway config file path for either service. Both services need
the repo root available at build time because workspace configuration (lockfile,
TypeScript, Vite, Sequelize CLI) lives at the root.

The repo root has a generic `start` script so Railpack can detect a runnable
Node app during analysis. Keep the explicit service start commands above set in
Railway, especially for the frontend.

## Environment variables

### Backend

```bash
RAILWAY_DEPLOY_TARGET=backend
CORS_ORIGIN=https://app.yourdomain.com
SESSION_COOKIE_DOMAIN=.yourdomain.com
DATABASE_URL=${{Postgres.DATABASE_URL}}
CSV_UPLOAD_DIR=/data/uploads/csv
DEFAULT_CURRENCY=CAD
DEMO_ACCOUNT_ENABLED=false
YARN_PRODUCTION=false
```

`SESSION_COOKIE_DOMAIN` is **required for cross-subdomain auth on Safari/iOS**.
See [Cookies across subdomains](#cookies-across-subdomains) below — leave it
unset only when the UI and API share the exact same host.

### Frontend

```bash
RAILWAY_DEPLOY_TARGET=frontend
VITE_API_BASE=https://your-backend-service-url
YARN_PRODUCTION=false
```

**Do not set `NODE_ENV=production`** as a Railway variable. Yarn Classic uses
it during install and may skip build tools like TypeScript, Vite, and
Sequelize CLI. The backend start script sets `NODE_ENV=production` only at
runtime.

## Cookies across subdomains

Auth is a session cookie set by the backend. By default Railway gives the two
services unrelated hosts — e.g. `frontend-production-xxxx.up.railway.app` and
`backend-production-yyyy.up.railway.app`. Because `up.railway.app` is a public
suffix, those hosts are **cross-site**, so the session cookie is a *third-party*
cookie from the UI's perspective. The backend sends it `SameSite=None; Secure`,
which only *permits* third-party cookies — Safari (ITP), iOS browsers (all use
WebKit), Firefox strict, and Chrome incognito **block them outright**. Result:
login appears to succeed (HTTP 201) but the cookie never sticks, and every
subsequent `/api` call returns `401 Authentication required`.

**Fix — put both services under one parent domain so the cookie is first-party:**

1. Add Railway custom domains: `app.yourdomain.com` → frontend service,
   `api.yourdomain.com` → backend service (create the CNAME records Railway
   shows you).
2. Backend: set `SESSION_COOKIE_DOMAIN=.yourdomain.com` and
   `CORS_ORIGIN=https://app.yourdomain.com`.
3. Frontend: set `VITE_API_BASE=https://api.yourdomain.com` and redeploy (the
   value is baked at build time, so a rebuild is required).
4. If Gmail/Google OAuth is enabled, update the authorized redirect URI in the
   Google console to the new `https://api.yourdomain.com/...` callback.

With `SESSION_COOKIE_DOMAIN=.yourdomain.com` the cookie is scoped to the shared
parent, making it first-party to both `app.` and `api.` — accepted by every
browser. Leave `SESSION_COOKIE_DOMAIN` unset only when the UI and API are served
from the identical host (e.g. a single-origin reverse proxy).

## Storage

### Postgres

Attach the Railway Postgres plugin and reference it via
`DATABASE_URL=${{Postgres.DATABASE_URL}}`. Application records live here.

### CSV uploads (folder import only)

Attach a Railway volume mounted at `/data` and set
`CSV_UPLOAD_DIR=/data/uploads/csv` **only if** you use folder-based imports.
Web CSV uploads are parsed from memory and never store the source file.

### Receipt files (Railway Buckets)

Receipt images are stored in a Railway Bucket via the S3-compatible API. Create
a bucket and set on the backend service:

```bash
AWS_ENDPOINT_URL=<bucket endpoint>
AWS_ACCESS_KEY_ID=<bucket access key>
AWS_SECRET_ACCESS_KEY=<bucket secret key>
AWS_S3_BUCKET_NAME=<bucket name>
AWS_DEFAULT_REGION=<bucket region>
```

Optional:

```bash
RECEIPTS_S3_KEY_PREFIX=receipts
AWS_S3_FORCE_PATH_STYLE=true
```
