# GitHub-Managed Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Cashflow from "Railway builds + auto-deploys every push to `main`" to "CI builds Docker images on every main push; publishing a draft GitHub Release re-tags those images as `:production` and tells Railway to redeploy from the new image."

**Architecture:** Three pieces.

1. `.github/workflows/build-images.yml` builds backend + frontend images on every push to `main` and pushes to GHCR, tagged with `:sha-<short>` and `:main`. Layer caching via GitHub Actions cache.

2. [Release Drafter](https://github.com/release-drafter/release-drafter) maintains a draft GitHub Release with notes derived from merged PR titles + autolabeler-applied labels.

3. When a human publishes the draft, `.github/workflows/promote-to-production.yml` fires on `release: published`. It resolves the released tag to its commit SHA, re-tags both images from `:sha-<short>` to `:vX.Y.Z` and `:production` via `docker buildx imagetools create` (registry-level manifest copy — no pull/push of layers), then curls Railway Deploy Hook URLs for both services. Railway pulls `:production` and runs it. Railway does no building.

Why a human publish triggers downstream: GitHub does NOT trigger workflows from `GITHUB_TOKEN`-caused events. Release Drafter creates the draft using `GITHUB_TOKEN`, so the draft creation alone doesn't fire `promote-to-production`. A human clicking Publish in the UI counts as a user-action event and DOES fire it.

**Tech Stack:** GitHub Actions, [`release-drafter/release-drafter@v6`](https://github.com/release-drafter/release-drafter), [`docker/build-push-action@v5`](https://github.com/docker/build-push-action), GHCR, Railway's image-pull + Deploy Hook integration.

---

## File Structure

**Created:**
- `backend/Dockerfile` — multi-stage; builder runs `tsc`, runner copies dist + node_modules and runs migrations + server
- `frontend/Dockerfile` — multi-stage; builder runs `vite build` with `VITE_API_BASE` as build-arg; runner is nginx:alpine serving the static dist
- `frontend/nginx.conf.template` — SPA fallback to `index.html`, `$PORT` substitution via nginx's built-in template processor
- `.dockerignore` — at repo root (single file, shared between both Docker contexts)
- `.github/release-drafter.yml` — categories (incl. Breaking Changes), version-resolver, autolabeler, release-notes template
- `.github/workflows/release-drafter.yml` — runs on PR open/update (autolabel) and push to `main` (refresh draft)
- `.github/workflows/build-images.yml` — matrix builds backend + frontend images, pushes to GHCR
- `.github/workflows/promote-to-production.yml` — on release publish, re-tags images and triggers Railway hooks

**Modified:**
- `README.md` — Releases section explaining the image-based flow

**One-time, non-file changes:**
- GitHub repo settings: workflow permissions ("Read and write" + "Allow GitHub Actions to create and approve pull requests")
- GitHub Actions Secrets:
  - `VITE_API_BASE` — public URL of the backend Railway service
  - `RAILWAY_BACKEND_DEPLOY_HOOK` — backend service Deploy Hook URL
  - `RAILWAY_FRONTEND_DEPLOY_HOOK` — frontend service Deploy Hook URL
- Railway: switch backend + frontend services from "Deploy from GitHub" (source) to "Deploy a Docker image" (image), pointing at `ghcr.io/connor-adams/cashflow-{backend,frontend}:production`
- Railway: add a Deploy Hook to each service (the URLs go into the GitHub Secrets above)
- Railway: add GHCR pull credentials (a PAT with `read:packages` scope, or use GitHub App-based auth if Railway supports it)
- GHCR: ensure the image visibility allows Railway to pull (private packages need pull credentials; can also be made public if comfortable with that)

---

## Out of Scope

- `GET /api/version` endpoint and a frontend footer badge. With image-based deploys, the version baked into the image at build time would be the right source. Doable as a follow-up: write the git SHA / tag to a build artifact during `docker build`, expose at `/api/version`, surface in the UI.
- `/api/v1` URL prefix for API stability. Relevant now that the bookmarklet (PR #47) is a second client, but separable.
- `workflow_dispatch` rollback workflow — instead, the README documents the manual rollback recipe.

---

## Task 1: Backend Dockerfile + `.dockerignore`

**Files:**
- Create: `backend/Dockerfile`
- Create: `.dockerignore` (at repo root)

- [ ] **Step 1: Write `backend/Dockerfile`**

Multi-stage. Builder installs all workspaces' deps (Yarn 1 limitation — it installs all workspaces; the frontend deps come along even though we don't need them at runtime — acceptable image bloat). Builder compiles `tsc`. Runner copies node_modules + backend + shared + workspace package.jsons (workspace structure needed for `yarn run db:migrate` at startup).

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

RUN yarn install --frozen-lockfile

COPY backend/ ./backend/
COPY shared/ ./shared/

RUN yarn workspace cashflow-backend build

FROM node:22-slim AS runner
WORKDIR /app

RUN corepack enable

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/package.json ./
COPY --from=builder /app/yarn.lock ./

WORKDIR /app/backend

ENV NODE_ENV=production

EXPOSE 3001

CMD ["sh", "-c", "yarn run db:migrate && node dist/server.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
.git
.github
.husky
.claude
.vscode
.idea

**/node_modules
**/dist
**/build

**/.env
**/.env.*
!**/.env.example

**/test
**/tests
**/__tests__
**/*.test.ts
**/*.test.tsx

docs
*.md

**/data
**/uploads

.DS_Store
**/.DS_Store
```

- [ ] **Step 3: Commit**

```bash
git add backend/Dockerfile .dockerignore
git commit -m "ci: add backend Dockerfile and .dockerignore for image-based deploy"
```

Note: not building/testing the image locally as part of the plan — CI is the first place it builds. If you want a local test, `docker build -f backend/Dockerfile -t cashflow-backend:local .` from the repo root.

---

## Task 2: Frontend Dockerfile + nginx config

**Files:**
- Create: `frontend/Dockerfile`
- Create: `frontend/nginx.conf.template`

- [ ] **Step 1: Write `frontend/Dockerfile`**

`VITE_API_BASE` is baked at build time via Docker build-arg. Runner is `nginx:alpine` serving the static dist. `nginx:alpine`'s built-in template processor will substitute `${PORT}` from environment when starting.

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

RUN yarn install --frozen-lockfile

COPY frontend/ ./frontend/
COPY shared/ ./shared/

ARG VITE_API_BASE
ENV VITE_API_BASE=$VITE_API_BASE

RUN yarn workspace frontend build

FROM nginx:alpine AS runner

ENV PORT=80

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
```

- [ ] **Step 2: Write `frontend/nginx.conf.template`**

`$PORT` will be substituted by nginx's entrypoint via envsubst. SPA fallback sends unknown paths to `index.html` for React Router. Vite's content-hashed asset filenames get long cache.

```nginx
server {
  listen ${PORT};
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/Dockerfile frontend/nginx.conf.template
git commit -m "ci: add frontend Dockerfile and nginx config for image-based deploy"
```

---

## Task 3: Release Drafter config

**Files:**
- Create: `.github/release-drafter.yml`

Configures categories (Breaking Changes at top, then Features, Bug Fixes, Performance, Dependencies, Maintenance), version-resolver, autolabeler matching conventional-commit titles, and release-notes template.

- [ ] **Step 1: Write the config**

```yaml
name-template: 'v$RESOLVED_VERSION'
tag-template: 'v$RESOLVED_VERSION'

categories:
  - title: 'Breaking Changes'
    labels:
      - 'breaking'
      - 'major'
  - title: 'Features'
    labels:
      - 'feature'
      - 'enhancement'
  - title: 'Bug Fixes'
    labels:
      - 'fix'
      - 'bug'
  - title: 'Performance'
    labels:
      - 'performance'
  - title: 'Dependencies'
    labels:
      - 'dependencies'
  - title: 'Maintenance'
    labels:
      - 'chore'
      - 'refactor'
      - 'test'
      - 'build'
      - 'ci'
      - 'documentation'

exclude-labels:
  - 'skip-changelog'

version-resolver:
  major:
    labels:
      - 'breaking'
      - 'major'
  minor:
    labels:
      - 'feature'
      - 'minor'
  patch:
    labels:
      - 'fix'
      - 'patch'
      - 'bug'
      - 'performance'
      - 'dependencies'
  default: patch

autolabeler:
  - label: 'feature'
    title:
      - '/^feat(\(.+\))?:/'
  - label: 'fix'
    title:
      - '/^fix(\(.+\))?:/'
  - label: 'performance'
    title:
      - '/^perf(\(.+\))?:/'
  - label: 'dependencies'
    title:
      - '/^deps(\(.+\))?:/'
  - label: 'chore'
    title:
      - '/^chore(\(.+\))?:/'
  - label: 'refactor'
    title:
      - '/^refactor(\(.+\))?:/'
  - label: 'test'
    title:
      - '/^test(\(.+\))?:/'
  - label: 'build'
    title:
      - '/^build(\(.+\))?:/'
  - label: 'ci'
    title:
      - '/^ci(\(.+\))?:/'
  - label: 'documentation'
    title:
      - '/^docs(\(.+\))?:/'
  - label: 'breaking'
    title:
      - '/^[a-z]+(\(.+\))?!:/'

change-template: '- $TITLE (#$NUMBER) by @$AUTHOR'
change-title-escapes: '\<*_&'

template: |
  ## What's Changed

  $CHANGES

  **Full Changelog**: https://github.com/$OWNER/$REPOSITORY/compare/$PREVIOUS_TAG...v$RESOLVED_VERSION
```

- [ ] **Step 2: Commit**

```bash
git add .github/release-drafter.yml
git commit -m "ci: add Release Drafter config"
```

---

## Task 4: Release Drafter workflow

**Files:**
- Create: `.github/workflows/release-drafter.yml`

Runs on `push: main` to refresh the draft, AND on `pull_request` events to autolabel PRs as they're opened/updated.

- [ ] **Step 1: Write the workflow**

```yaml
name: release-drafter

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, reopened, synchronize]

permissions:
  contents: read

concurrency:
  group: release-drafter-${{ github.ref }}
  cancel-in-progress: false

jobs:
  update-release-draft:
    permissions:
      contents: write
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
      - uses: release-drafter/release-drafter@v6
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release-drafter.yml
git commit -m "ci: add Release Drafter workflow"
```

---

## Task 5: Build-images workflow

**Files:**
- Create: `.github/workflows/build-images.yml`

Matrix builds backend + frontend in parallel on every push to `main`. Pushes to GHCR with `:sha-<short>` and `:main` tags. Uses GHA cache for Docker layers.

- [ ] **Step 1: Write the workflow**

```yaml
name: build-images

on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write

concurrency:
  group: build-images-${{ github.ref }}
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        service: [backend, frontend]
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute image metadata
        id: meta
        run: |
          set -euo pipefail
          REPO_LC=$(echo "${{ github.repository }}" | tr '[:upper:]' '[:lower:]')
          SHA_SHORT=$(git rev-parse --short HEAD)
          echo "image=ghcr.io/${REPO_LC}-${{ matrix.service }}" >> "$GITHUB_OUTPUT"
          echo "sha_short=${SHA_SHORT}" >> "$GITHUB_OUTPUT"

      - name: Build and push ${{ matrix.service }}
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ${{ matrix.service }}/Dockerfile
          push: true
          tags: |
            ${{ steps.meta.outputs.image }}:sha-${{ steps.meta.outputs.sha_short }}
            ${{ steps.meta.outputs.image }}:main
          build-args: |
            VITE_API_BASE=${{ secrets.VITE_API_BASE }}
          cache-from: type=gha,scope=${{ matrix.service }}
          cache-to: type=gha,mode=max,scope=${{ matrix.service }}
```

The backend Dockerfile doesn't declare `VITE_API_BASE` as `ARG`, so the build-arg is ignored harmlessly. Keeps the workflow uniform between services.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/build-images.yml
git commit -m "ci: build + push backend and frontend images to GHCR on main"
```

---

## Task 6: Promote-to-production workflow

**Files:**
- Create: `.github/workflows/promote-to-production.yml`

Fires on `release: published`. Resolves the released tag to its source commit (handling both lightweight and annotated tags), re-tags `:sha-<short>` images as `:vX.Y.Z` and `:production` via `docker buildx imagetools create` (which operates on registry manifests — no layer pull/push), then curls the Railway Deploy Hooks for both services.

- [ ] **Step 1: Write the workflow**

```yaml
name: promote-to-production

on:
  release:
    types: [published]

permissions:
  contents: read
  packages: write

concurrency:
  group: promote-to-production
  cancel-in-progress: false

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Resolve release tag to source commit
        id: resolve
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          TAG="${{ github.event.release.tag_name }}"
          REPO="${{ github.repository }}"
          REPO_LC=$(echo "$REPO" | tr '[:upper:]' '[:lower:]')

          REF=$(gh api "/repos/$REPO/git/ref/tags/$TAG")
          OBJ_TYPE=$(echo "$REF" | jq -r .object.type)
          OBJ_SHA=$(echo "$REF" | jq -r .object.sha)
          if [ "$OBJ_TYPE" = "tag" ]; then
            COMMIT_SHA=$(gh api "/repos/$REPO/git/tags/$OBJ_SHA" --jq .object.sha)
          else
            COMMIT_SHA=$OBJ_SHA
          fi
          SHA_SHORT=$(echo "$COMMIT_SHA" | cut -c1-7)

          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "sha_short=$SHA_SHORT" >> "$GITHUB_OUTPUT"
          echo "backend=ghcr.io/${REPO_LC}-backend" >> "$GITHUB_OUTPUT"
          echo "frontend=ghcr.io/${REPO_LC}-frontend" >> "$GITHUB_OUTPUT"
          echo "Released tag $TAG -> commit $COMMIT_SHA (short $SHA_SHORT)"

      - name: Re-tag backend image as release version and :production
        run: |
          set -euo pipefail
          docker buildx imagetools create \
            --tag "${{ steps.resolve.outputs.backend }}:${{ steps.resolve.outputs.tag }}" \
            --tag "${{ steps.resolve.outputs.backend }}:production" \
            "${{ steps.resolve.outputs.backend }}:sha-${{ steps.resolve.outputs.sha_short }}"

      - name: Re-tag frontend image as release version and :production
        run: |
          set -euo pipefail
          docker buildx imagetools create \
            --tag "${{ steps.resolve.outputs.frontend }}:${{ steps.resolve.outputs.tag }}" \
            --tag "${{ steps.resolve.outputs.frontend }}:production" \
            "${{ steps.resolve.outputs.frontend }}:sha-${{ steps.resolve.outputs.sha_short }}"

      - name: Trigger Railway backend redeploy
        env:
          HOOK: ${{ secrets.RAILWAY_BACKEND_DEPLOY_HOOK }}
        run: |
          set -euo pipefail
          if [ -z "${HOOK}" ]; then
            echo "RAILWAY_BACKEND_DEPLOY_HOOK secret is not set" >&2
            exit 1
          fi
          curl -fsS -X POST "$HOOK"

      - name: Trigger Railway frontend redeploy
        env:
          HOOK: ${{ secrets.RAILWAY_FRONTEND_DEPLOY_HOOK }}
        run: |
          set -euo pipefail
          if [ -z "${HOOK}" ]; then
            echo "RAILWAY_FRONTEND_DEPLOY_HOOK secret is not set" >&2
            exit 1
          fi
          curl -fsS -X POST "$HOOK"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/promote-to-production.yml
git commit -m "ci: rewrite promote-to-production to re-tag GHCR images and trigger Railway hooks"
```

---

## Task 7: Document the release flow in README

**Files:**
- Modify: `README.md`

Insert/replace the `## Releases` section AFTER `## Demo account` and BEFORE `## Deploy`.

- [ ] **Step 1: Add the section** (see README content in the implementation — describes the image-based flow, required secrets, version-bump table, and rollback recipe)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document GitHub-managed release flow"
```

---

## Task 8: Required GitHub repo settings + secrets (manual)

No code; settings only. Do this BEFORE merging the first PR after this work lands, so the first build/draft can succeed.

- [ ] **Step 1: Workflow permissions**

Repo Settings → Actions → General → Workflow permissions:
- Select **Read and write permissions**
- Check **Allow GitHub Actions to create and approve pull requests**
- Save

- [ ] **Step 2: GitHub Actions Secrets**

Repo Settings → Secrets and variables → Actions → New repository secret. Add three secrets:

- `VITE_API_BASE` — the public URL of the backend Railway service (e.g. `https://backend-production-xxxx.up.railway.app`)
- `RAILWAY_BACKEND_DEPLOY_HOOK` — see Task 9
- `RAILWAY_FRONTEND_DEPLOY_HOOK` — see Task 9

- [ ] **Step 3: Verify via gh CLI**

```bash
gh api /repos/:owner/:repo/actions/permissions/workflow
gh secret list
```

Expected: workflow permissions show `default_workflow_permissions: "write"`, `can_approve_pull_request_reviews: true`. Secrets list shows the three secrets above (values not shown).

---

## Task 9: Reconfigure Railway for image-based deploys (manual, Railway dashboard)

This is the biggest one-time change. Both backend and frontend services switch from "Deploy from GitHub" to "Deploy a Docker image". Read all steps first.

- [ ] **Step 1: Add a Deploy Hook to each service**

In the Railway dashboard, open each service → Settings → Deploy → **Deploy Triggers** → **Add Deploy Hook**. Copy the URL. Add to the GitHub Actions secrets from Task 8 (`RAILWAY_BACKEND_DEPLOY_HOOK`, `RAILWAY_FRONTEND_DEPLOY_HOOK`).

- [ ] **Step 2: Set up GHCR pull credentials on Railway**

GHCR private images require auth. Create a GitHub Personal Access Token with `read:packages` scope (Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token).

In each Railway service → Settings → **Image** (or **Registry credentials**), provide:
- Registry: `ghcr.io`
- Username: your GitHub username
- Password: the PAT from above

(If your GHCR packages are public, you can skip this step. To make them public: GHCR package settings → Change visibility → Public.)

- [ ] **Step 3: Switch backend service source to image**

Backend service → Settings → **Source**:
- Change from GitHub repo to **Docker Image**
- Image: `ghcr.io/connor-adams/cashflow-backend:production`
- Save

The service will fail until the first promotion succeeds (Task 11). That's OK — the previous source-based deployment keeps running until the new config takes effect.

- [ ] **Step 4: Switch frontend service source to image**

Same for frontend, using `ghcr.io/connor-adams/cashflow-frontend:production`.

- [ ] **Step 5: Verify Deploy Hooks work**

```bash
curl -fsS -X POST "$RAILWAY_BACKEND_DEPLOY_HOOK"
curl -fsS -X POST "$RAILWAY_FRONTEND_DEPLOY_HOOK"
```

Railway dashboard should show a redeploy attempt for each service. They'll fail (no `:production` tag yet) but the hooks are confirmed working.

---

## Task 10: Verify first end-to-end build

- [ ] **Step 1: After this PR merges to `main`, watch the build-images workflow**

```bash
gh run list --workflow=build-images.yml --limit 1
gh run watch
```

Expected: both `backend` and `frontend` matrix jobs `success`. Images visible at:

```bash
gh api /user/packages/container/cashflow-backend/versions --jq '.[].metadata.container.tags'
```

Expected: a `sha-<short>` tag and `main` tag for both images.

---

## Task 11: Trigger and verify the first end-to-end release

- [ ] **Step 1: Open and merge a feat or fix PR**

Any real user-facing change with a conventional-commit title. Confirm the autolabeler tags it before merging:

```bash
gh pr view <pr-number> --json labels
```

- [ ] **Step 2: Watch the draft release update**

```bash
gh release list
gh release view <tag>
```

Expected: draft release with the new PR's entry.

- [ ] **Step 3: Publish the draft**

GitHub UI → Releases → Drafts → click the draft → **Publish release**. Confirm tag name + version.

- [ ] **Step 4: Watch promote-to-production fire**

```bash
gh run list --workflow=promote-to-production.yml --limit 1
gh run view --log
```

Expected: all steps `success`. Last two steps confirm Railway hooks returned 2xx.

- [ ] **Step 5: Verify Railway deployed the new image**

Railway dashboard shows new deployments on both services. Health check:

```bash
curl -fsS https://<your-backend-railway-url>/api/health
```

The Railway deployment logs should show the image tag (`:production`) and its digest, matching the just-promoted release.

---

## Verification checklist

After all tasks complete:

- [ ] `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf.template`, `.dockerignore` exist
- [ ] `.github/release-drafter.yml`, `.github/workflows/{release-drafter,build-images,promote-to-production}.yml` exist
- [ ] GitHub Actions Secrets configured: `VITE_API_BASE`, `RAILWAY_BACKEND_DEPLOY_HOOK`, `RAILWAY_FRONTEND_DEPLOY_HOOK`
- [ ] GHCR contains `cashflow-backend` and `cashflow-frontend` packages with `:sha-*`, `:main`, and (after first release) `:vX.Y.Z` + `:production` tags
- [ ] Railway backend + frontend services deploy from `ghcr.io/connor-adams/cashflow-{backend,frontend}:production`
- [ ] Pushing to `main` builds + pushes images but does NOT trigger a Railway deploy
- [ ] Publishing a draft release re-tags images and triggers Railway redeploys
- [ ] Health check responds 200 after a release publish
- [ ] README's Releases section accurately describes the flow
