# Releasing & rollback

Cashflow ships via a three-piece, image-based pipeline. `main` does **not**
auto-deploy — only publishing a GitHub Release triggers a Railway redeploy.

1. **CI builds Docker images** on every push to `main` and pushes them to GitHub
   Container Registry (GHCR), tagged with the commit SHA.
2. **[Release Drafter](https://github.com/release-drafter/release-drafter)**
   maintains a draft GitHub Release with notes auto-generated from merged PR
   titles.
3. **Publishing a release** re-tags the corresponding images `:vX.Y.Z` and
   `:production`, then triggers Railway to redeploy. Railway services pull images
   from GHCR — they don't build anything themselves.

## To ship to production

1. Open a PR with a conventional-commit title (`feat:`, `fix:`, `docs:`, etc.).
   Release Drafter auto-labels the PR from the title prefix.
2. When the PR merges to `main`:
   - The `build-images` workflow builds the backend and frontend images and
     pushes them to GHCR (`ghcr.io/connor-adams/cashflow-{backend,frontend}:sha-<short>`).
   - Release Drafter updates the draft GitHub Release.
3. When ready to ship, go to **Releases → Drafts** in GitHub. **Wait for the
   `build-images` run on the latest `main` commit to finish** before publishing —
   the promote workflow re-tags those images and fails fast if they don't exist
   yet. Eyeball the notes and version, edit if needed, click **Publish release**.
4. Publishing fires a `release: published` event (human action, not
   `GITHUB_TOKEN`). The `promote-to-production` workflow:
   - Re-tags the released commit's images as `:vX.Y.Z` and `:production`.
   - Calls Railway's deploy hooks for both services.
   Railway pulls the new `:production` image and runs it.

## Version bumps

Suggested by Drafter; override at Publish time.

- `feat:` → minor
- `fix:` / `perf:` / `deps:` → patch
- `feat!:` or any title with `!` after the type → major
- `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` → patch default; you
  choose whether to publish a release with only these

## Required GitHub Secrets

- `VITE_API_BASE` — public URL of the backend Railway service, baked into the
  frontend image at build time.
- `RAILWAY_TOKEN` — Railway project token the promote workflow uses to call
  `railway redeploy` against each service.

## Rollback

Re-tag an older `:vX.Y.Z` image as `:production`, then trigger Railway
redeploys. From a workstation with `docker buildx` and the Railway CLI linked to
the project:

```bash
TAG=v0.1.4
IMG_BE=ghcr.io/connor-adams/cashflow-backend
IMG_FE=ghcr.io/connor-adams/cashflow-frontend

docker buildx imagetools create --tag $IMG_BE:production $IMG_BE:$TAG
docker buildx imagetools create --tag $IMG_FE:production $IMG_FE:$TAG

railway redeploy --service 42977748-ab5c-4552-a206-faf86d353e5b -y
railway redeploy --service e0dc05b7-3961-4d4f-aea9-bed3810ea2f5 -y
```

A dedicated `workflow_dispatch` rollback workflow would be cleaner but is not
currently configured.

See [deploy-railway.md](deploy-railway.md) for Railway service configuration,
environment variables, and storage setup (Postgres, volume mount, Railway
Buckets for receipts).
