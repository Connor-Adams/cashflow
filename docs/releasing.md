# Releasing & rollback

Cashflow ships via an image-based pipeline. `main` does **not** auto-deploy, and
**publishing a release does not deploy either** — it pins a version. Deploying
is a separate, human step in Dokploy.

1. **CI builds Docker images** on every push to `main` and pushes them to GitHub
   Container Registry (GHCR), tagged with the commit SHA, a content hash
   (`:tree-<hash>`), and `:main`. Builds are content-addressed, so a
   backend-only change leaves the frontend image alone — `frontend:main` can
   legitimately sit several commits behind `backend:main`.
2. **[Release Drafter](https://github.com/release-drafter/release-drafter)**
   maintains a draft GitHub Release with notes auto-generated from merged PR
   titles.
3. **Publishing a release** stamps every service's image `:vX.Y.Z` and moves
   `:production` onto the services whose image actually changed.
4. **Deploying** = redeploying in Dokploy, which pulls `:production`.

## To ship to production

1. Open a PR with a conventional-commit title (`feat:`, `fix:`, `docs:`, etc.).
   Release Drafter auto-labels the PR from the title prefix.
2. When the PR merges to `main`, the `build-images` workflow pushes the changed
   images to GHCR (`ghcr.io/connor-adams/cashflow-{backend,frontend}:sha-<short>`
   plus `:tree-<hash>` and `:main`).
3. When ready to ship, go to **Releases → Drafts** in GitHub. **Wait for the
   `build-images` run on the latest `main` commit to finish** — the promote
   workflow re-tags those images and fails if they don't exist yet. Eyeball the
   notes and version, then **Publish release**.
4. `promote-to-production` runs. It version-stamps every service, moves
   `:production` for the changed ones, and **ends there**. Its run summary names
   the services that need deploying. A green run means "images pinned", not
   "production updated".
5. **Redeploy those services in Dokploy.** Each application pulls
   `ghcr.io/connor-adams/cashflow-<service>:production`.

### Why CI doesn't deploy

The Dokploy panel is on a LAN address, unreachable from a GitHub-hosted runner.
Dokploy already exposes what automation would need — each application has
`autoDeploy` enabled and a deploy webhook at `POST /api/deploy/<refreshToken>` —
so if the panel is ever put behind a public hostname, the promote workflow grows
one `curl` step and nothing else changes.

### Re-promoting a release

`promote-to-production` also takes a `workflow_dispatch` with a `tag` input. Use
it when a promotion failed part-way; it is idempotent, and finishes the job
without cutting a new version.

## Version bumps

Suggested by Drafter; override at Publish time.

- `feat:` → minor
- `fix:` / `perf:` / `deps:` → patch
- `feat!:` or any title with `!` after the type → major
- `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` → patch default; you
  choose whether to publish a release with only these

## Required GitHub Secrets

- `VITE_API_BASE` — public URL of the backend service, baked into the frontend
  image at build time.

(`GITHUB_TOKEN` covers GHCR pushes. No deploy credential is needed while the
redeploy is manual.)

## Rollback

`:production` is a pointer, so rolling back is re-pointing it at an older
version tag and redeploying. From a workstation with `docker buildx` and a GHCR
login that has `write:packages`:

```bash
TAG=v0.13.186
IMG_BE=ghcr.io/connor-adams/cashflow-backend
IMG_FE=ghcr.io/connor-adams/cashflow-frontend

docker buildx imagetools create --tag $IMG_BE:production $IMG_BE:$TAG
docker buildx imagetools create --tag $IMG_FE:production $IMG_FE:$TAG
```

Then redeploy both applications in Dokploy.

Every release stamps a complete per-service image set, so any published version
is a valid rollback target even for services that didn't change in it.

See [superpowers/plans/2026-09-23-cashflow-dokploy-migration.md](superpowers/plans/2026-09-23-cashflow-dokploy-migration.md)
for the Dokploy project layout, and [deploy-railway.md](deploy-railway.md) for
the retired Railway setup (historical only).
