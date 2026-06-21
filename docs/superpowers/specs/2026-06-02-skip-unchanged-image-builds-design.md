# Skip unchanged image builds + bumps

**Date:** 2026-06-02
**Status:** Approved (design)
**Scope:** `.github/workflows/build-images.yml`, `.github/workflows/promote-to-production.yml`, new `scripts/service-content-hash.cjs`

## Problem

`build-images.yml` rebuilds and re-pushes **all 7** service images (backend, frontend,
otel-collector, loki, prometheus, grafana, tempo) on every non-docs push to `main`.
The matrix has no per-service change detection. The 5 infra images almost never change
but rebuild every merge.

This is load-bearing, not pure waste: `promote-to-production.yml` (runs on `release:
published`) re-tags **all 7** images by the exact release commit SHA (`:sha-<SHA>`),
waits for all 7 to exist, then re-tags `:<RELEASE_TAG>` + `:production` and redeploys
all 7 on Railway. Skipping a build today would break promote's "verify all 7 at
`:sha-<SHA>`" step.

Two costs of the current setup:
1. **CI churn / cost** — 7 build jobs every merge; 7 redeploys every release.
2. **Docker Hub timeout** — `docker/setup-buildx-action` boots the `docker-container`
   driver by pulling `moby/buildkit` from Docker Hub. The workflows authenticate only
   to GHCR, never Docker Hub, so that pull is anonymous and hits Docker Hub's rate
   limit on shared GitHub runner IPs:
   `Get "https://registry-1.docker.io/v2/": net/http: request canceled (Client.Timeout
   exceeded while awaiting headers)`.
   Running `setup-buildx` in 7 jobs per push multiplies the exposure.

## Goal

Build a service only when its source actually changed; bump (`:<RELEASE_TAG>` snapshot)
all services at release but redeploy only the changed ones. The same change-detection
mechanism must drive both build-skip and promote-resolve so they cannot disagree.

Authenticating to Docker Hub to fix the timeout at its root is a **separate,
complementary** change (see Out of Scope). This spec reduces the timeout's blast radius
as a side effect (far fewer `setup-buildx` invocations) but does not depend on it.

## Approach: content-addressed image tags

Each service gets a **content hash** derived from the git object ids of its input paths.
A service's image is tagged `:tree-<H>`. The build runs **iff** `:tree-<H>` is absent
from the registry; promote resolves each service by `:tree-<H>`. Because the same hash
function is evaluated at the same commit in both workflows, "should I build?" and "what
do I deploy?" are the same computation — drift is impossible by construction.

Properties:
- **Self-healing** — if an image is GC'd, the hash misses and it rebuilds.
- **Revert-friendly** — reverting to prior content yields the prior hash → instant reuse,
  no rebuild.
- **No "diff since when" ambiguity** — identity is the content, not a commit range, so
  force-pushes / failed prior builds / first runs are handled naturally.

### Rejected alternatives

- **Path-filter / git-diff matrix** (`dorny/paths-filter`, `before..after`): "diff since
  when" is fragile (force-push, first run, failed prior build → drift), and build path
  globs + promote history-walk are two mechanisms that must stay in sync.
- **Path-filter build + persisted digest map**: needs a persistent side-channel
  (artifact / orphan branch) that can desync from reality.

## The hash script — `scripts/service-content-hash.cjs`

Single source of truth for each service's inputs. A Node module (matching the repo's
`scripts/*.cjs` convention) exporting `serviceContentHash(service, ref='HEAD', {cwd})`
plus `SERVICES`/`INPUTS`/`EPOCH`, with a CLI entrypoint
(`node scripts/service-content-hash.cjs <service> [ref]`). Both workflows shell out to
the CLI; the unit tests import the function. Same module everywhere → the two workflows
can never compute different hashes for the same commit.

Algorithm: for each input path, read its git object id via
`git rev-parse <ref>:<path>` (tree for dirs, blob for files); concatenate
`epoch:<EPOCH>` + `<path>:<oid>` lines; `sha256` and truncate to 16 hex chars.

- `git rev-parse <ref>:<path>` changes iff the path's recursive content changes.
  Deterministic and independent of the working tree.
- A missing input path throws (fail loud).
- `EPOCH` is a constant in the module (NOT an env var, so build and promote can't drift).
  Bump it to force a full rebuild when build *logic* or a floating base image changes
  without any source change.
- 16 hex chars (64 bits) — collision risk negligible at this scale.

Input map: `backend → [package.json, yarn.lock, backend, shared]`,
`frontend → [package.json, yarn.lock, frontend, shared]`,
each infra service `→ [infra/<svc>]`.

### Input sets (derived from the Dockerfiles)

| Service | Inputs | Rationale |
|---|---|---|
| backend | `package.json`, `yarn.lock`, `backend/`, `shared/` | `backend/Dockerfile` copies root manifests, then `backend/` + `shared/`. Dockerfile lives in `backend/`. |
| frontend | `package.json`, `yarn.lock`, `frontend/`, `shared/` | `frontend/Dockerfile` copies root manifests, then `frontend/` + `shared/`. Dockerfile lives in `frontend/`. |
| otel-collector / loki / prometheus / grafana / tempo | `infra/<svc>/` | Each builds with `context: infra/<svc>`; fully self-contained, Dockerfile included. |

`shared/` changes rebuild **both** backend and frontend; root `package.json`/`yarn.lock`
changes do too. Infra services are mutually independent.

**Accepted imprecision:** `backend/Dockerfile` also `COPY`s `frontend/package.json` (for
the workspace install graph). A frontend-only `package.json` change therefore won't
rebuild backend. This is rare and cannot change backend's actual resolved deps in a way
that matters; if ever needed, bump `BUILD_EPOCH`.

## `build-images.yml` → `detect` + `build`

### Job `detect`

`permissions: { contents: read, packages: read }`. No `setup-buildx` → no buildkit pull.

1. `actions/checkout@v6` (default depth 1 is sufficient — the checked-out commit's full
   tree is present; only history is shallow).
2. `docker/login-action@v4` to `ghcr.io`.
3. For each of the 7 services: compute `H` via `service-content-hash.sh <svc>`, then
   `docker buildx imagetools inspect ghcr.io/<repo>-<svc>:tree-<H>`. (`imagetools`
   queries the registry directly via the default builder — no container driver, no
   Docker Hub pull.) Absent → the service needs building.
4. Emit outputs:
   - `matrix` — `{"include":[ {name, context, file, hash}, ... ]}` containing only the
     services that need building. The static `name → context/file` table moves here from
     the old matrix.
   - `any` — `"true"`/`"false"`.

### Job `build`

`needs: detect`, `if: needs.detect.outputs.any == 'true'`,
`strategy.matrix: ${{ fromJSON(needs.detect.outputs.matrix) }}`,
`permissions: { contents: read, packages: write }`. Same as the current build step except:

1. `actions/checkout@v6` with `fetch-depth: 0` (needed for `git describe` → `APP_VERSION`).
2. `docker/setup-buildx-action@v4` (the container driver — required for `cache-to:
   type=gha`). Now runs only for changed services, typically 0–2 instead of 7.
3. `docker/login-action@v4` to `ghcr.io`.
4. `docker/build-push-action@v7` with `provenance: false`, tags:
   ```
   ghcr.io/<repo>-<name>:tree-<hash>     # resolution key (used by promote)
   ghcr.io/<repo>-<name>:sha-<github.sha>  # traceability only
   ghcr.io/<repo>-<name>:main
   ```
   `cache-from`/`cache-to: type=gha,scope=<name>` unchanged. `build-args` unchanged
   (`VITE_API_BASE`, `APP_VERSION`). `APP_VERSION` is deliberately **not** in the content
   hash, so it never forces a rebuild.

Keep `concurrency: build-images-${{ github.ref }}` and the `paths-ignore` block
(redundant under content hashing but a harmless fast-path for docs-only pushes).

The dead `needs_app_args` matrix field is dropped (the build step already passes both
build-args unconditionally; undeclared ARGs are harmless to infra Dockerfiles).

## `promote-to-production.yml` → resolve by hash, tag all, redeploy changed

Replaces the 7×hardcoded re-tag steps and 7×hardcoded redeploy steps with one loop over a
`service → {image, railwayId}` table.

1. **Add** `actions/checkout@v6` with `ref: ${{ github.event.release.tag_name }}`
   (handles annotated tags transparently — resolves to the tagged commit).
   `RELEASE_SHA = git rev-parse HEAD`. This replaces the current `gh api` tag→SHA dance.
2. `docker/login-action@v4` to `ghcr.io`.
3. **Drop** `docker/setup-buildx-action` — `imagetools` needs no builder. This removes
   promote's own buildkit pull (a second timeout vector).
4. For each service (table of `image` + Railway `serviceId`):
   1. `H = service-content-hash.sh <svc> <RELEASE_SHA>`; `SRC=<image>:tree-<H>`.
   2. **Verify** `SRC` exists, retrying `IMAGE_WAIT_ATTEMPTS`×`IMAGE_WAIT_SECONDS`
      (keep current 30×10s — covers a release racing a still-running build). Missing
      after retries → fail loud (this release's content for the service was never built).
   3. **Version snapshot (all services):**
      `docker buildx imagetools create --tag <image>:<RELEASE_TAG> "$SRC"`.
   4. **Deploy decision:** compare `SRC`'s manifest digest
      (`imagetools inspect --format '{{.Manifest.Digest}}'`) against the live
      `<image>:production`. Because `imagetools create` wraps a single manifest in an OCI
      **index**, `:production`'s own digest will not equal `SRC`'s manifest digest — so
      treat it as **unchanged** if `SRC`'s digest matches `:production`'s own digest **or**
      any of its child manifest digests
      (`imagetools inspect --raw | jq -r '.manifests[]?.digest'`). A missing `:production`
      (first release) counts as changed.
      - **Changed:** `imagetools create --tag <image>:production "$SRC"`, then
        `railway redeploy --service <serviceId> -y`.
      - **Unchanged:** skip the `:production` re-tag and the redeploy. Log it.

The content digest — not the commit — gates redeploy, so it is robust against any drift
between build and promote. Failure mode if the comparison is ever wrong is safe
(over-redeploy), never a missed deploy.

Railway service ids stay in the workflow `env` block as today.

## Decisions

- **Full skip** — unchanged services get no build job and no redeploy.
- **Tag all, redeploy changed** — every release stamps `:<RELEASE_TAG>` on all 7 images
  (cheap manifest copy) for a clean per-service version snapshot / rollback target;
  only changed services update `:production` and redeploy. (Chosen over the stricter
  "skip the tag too," which would force version rollback to reconstruct each unchanged
  service's image from history.)
- **Content-addressed identity** over path-filtering (see Approach).

## Edge cases

- **Stale `APP_VERSION` on unchanged services** — intended. Their `/health` / telemetry
  version label reflects their last real change, not the current release. Documented so it
  is not a debugging surprise.
- **`VITE_API_BASE` (frontend build secret) is not in git** — changing it won't trigger a
  rebuild via the hash. Mitigation: bump `BUILD_EPOCH`.
- **Build-logic or floating base image (`node:22-slim`, `nginx:alpine`) changes** don't
  move the hash. Mitigation: bump `BUILD_EPOCH` to rebuild all. (Scheduled security
  rebuilds are out of scope.)
- **First run after rollout** — no `:tree-<H>` tags exist → all 7 build once. Expected.
- **`:sha-<SHA>`** is demoted to traceability; nothing resolves by it anymore.
- **Release of a commit whose build failed** — `:tree-<H>` absent → promote fails loud
  after the wait loop. Correct: never deploy something that was never built.

## Testing

All under the existing `yarn test:workflows` harness (`node --test test/*.test.cjs`):

- `test/serviceContentHash.test.cjs` — unit tests over a throwaway fixture git repo:
  deterministic per `(service, ref)`; distinct services hash differently; changing
  `shared/` rebuilds backend **and** frontend but no infra; `backend/` rebuilds backend
  only; root `package.json` rebuilds backend + frontend; one infra service is independent
  of the others; unknown service throws.
- `test/buildImagesWorkflow.test.cjs` — structural guard: detect + content-gated build
  jobs, matrix wiring, `:tree-<hash>` tagging, all services covered.
- `test/promoteWorkflow.test.cjs` — structural guard: release-tag checkout, hash
  resolution, image-wait loop, version-tag-all, index-aware deploy gate, all services +
  Railway targets.
- GitHub Actions cannot be fully exercised locally — the first real `main` push and the
  first real release after rollout are watched closely.

## Out of scope

- **Docker Hub authentication** — adding `docker/login-action` for `docker.io` before
  `setup-buildx` (with `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets) is the root fix for
  the registry timeout and is recommended as a separate small change. This spec reduces
  the number of `setup-buildx` runs but does not authenticate Docker Hub.
- **Scheduled/periodic base-image security rebuilds.**
- The `ci.yml` test/build pipeline (Node, not Docker images) is untouched.
