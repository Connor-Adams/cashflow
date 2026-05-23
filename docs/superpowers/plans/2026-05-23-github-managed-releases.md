# GitHub-Managed Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Cashflow from "every push to `main` deploys to prod" to "publishing a draft GitHub Release cuts a tag that advances a `production` branch Railway deploys from."

**Architecture:** Two GitHub Actions plus one long-lived branch. [Release Drafter](https://github.com/release-drafter/release-drafter) watches `main` and maintains an open *draft* GitHub Release containing auto-generated notes derived from merged PR titles + labels. It also auto-labels PRs on open/update from their conventional-commit title so labeling is automatic. When you're ready to ship, you go to the Releases tab, click **Publish** on the draft. Because publish is a *human* action (not `GITHUB_TOKEN`), the `release: published` event DOES trigger downstream workflows. A second workflow listens for that event and fast-forwards `production` to the tagged commit. Railway is reconfigured to deploy from `production` instead of `main`.

**Tech Stack:** GitHub Actions, [`release-drafter/release-drafter@v6`](https://github.com/release-drafter/release-drafter), Railway's branch-tracking GitHub integration.

---

## File Structure

**Created:**
- `.github/release-drafter.yml` — config: categories, version-resolver, autolabeler, template
- `.github/workflows/release-drafter.yml` — runs Release Drafter on PR open/update (autolabel) and on push to `main` (refresh draft)
- `.github/workflows/promote-to-production.yml` — listens for `release: published`, fast-forwards `production`

**Modified:**
- `README.md` — add a Releases section

**One-time, non-file changes:**
- `production` git branch created from current `main` HEAD
- GitHub repo settings: workflow permissions ("Read and write" + "Allow GitHub Actions to create and approve pull requests")
- (Optional) branch protection rule on `production`
- Railway service config: change tracked branch from `main` to `production` on both backend and frontend services

---

## Out of Scope

- `GET /api/version` endpoint and a frontend footer badge ("versioning A" from earlier discussion). With Release Drafter, the version lives only in the git tag — there's no `package.json` bump. If you want in-app version visibility later, a build-time step can write the tag into a generated file or env var; that's a separate additive piece.
- `/api/v1` URL prefix for API stability. Relevant now that the bookmarklet from PR #47 is a second client, but separable.

---

## Why Release Drafter (and not release-please)

`release-please` requires merging an additional "chore: release X.Y.Z" PR each ship because it writes the version bump and `CHANGELOG.md` to source. Release Drafter keeps the pending release in the GitHub UI as a draft, so there's no PR-overhead per ship.

Release Drafter also unlocks a cleaner two-workflow architecture: GitHub does NOT trigger downstream workflows from events caused by `GITHUB_TOKEN`. `release-please` creates the release using `GITHUB_TOKEN`, so a separate `release: published` workflow would never fire — forcing a unified workflow. With Release Drafter, the draft is created by `GITHUB_TOKEN` but **published by a human** clicking Publish, which DOES trigger downstream workflows. So we can keep concerns split across two small workflows.

---

## Task 1: Add Release Drafter config

**Files:**
- Create: `.github/release-drafter.yml`

This file configures categories, version resolution, autolabeler rules, and the release-notes template. The autolabeler is what makes the workflow "automatic from conventional commit titles" — without it, you'd have to manually apply labels to every PR.

- [ ] **Step 1: Write the config**

```yaml
name-template: 'v$RESOLVED_VERSION'
tag-template: 'v$RESOLVED_VERSION'

categories:
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

Notes:
- The `breaking` autolabel uses `/^[a-z]+(\(.+\))?!:/` to match any conventional commit type with a `!` marker (e.g. `feat!:`, `feat(api)!:`).
- `default: patch` means a release with only docs/chore PRs will still be suggested as a patch bump in the draft. You can override the version at publish time; or simply don't publish a release with nothing user-facing.
- All categories (including "Maintenance") show in the notes. If you'd rather hide docs/chore PRs from notes, move `documentation`/`chore`/etc. into `exclude-labels:` instead of keeping them in `categories:`.

- [ ] **Step 2: Validate YAML parses**

```bash
node -e "require('js-yaml').load(require('fs').readFileSync('.github/release-drafter.yml','utf8'))"
```

If `js-yaml` isn't installed locally, use `python3 -c "import yaml; yaml.safe_load(open('.github/release-drafter.yml'))"` instead.

Expected: exits cleanly.

- [ ] **Step 3: Commit**

```bash
git add .github/release-drafter.yml
git commit -m "ci: add Release Drafter config"
```

---

## Task 2: Add Release Drafter workflow

**Files:**
- Create: `.github/workflows/release-drafter.yml`

Runs on push to `main` (refreshes draft) AND on PR open/reopen/sync (autolabels).

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

Notes:
- Job-level `permissions` overrides the workflow-level `contents: read` for this job. `contents: write` lets the action create/update the draft release; `pull-requests: write` lets the autolabeler add labels.
- `concurrency` prevents two PR-update events from racing on the same draft.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release-drafter.yml
git commit -m "ci: add Release Drafter workflow"
```

---

## Task 3: Add promote-to-production workflow

**Files:**
- Create: `.github/workflows/promote-to-production.yml`

Listens for `release: published`, fast-forwards `production` to the released tag.

- [ ] **Step 1: Write the workflow**

```yaml
name: promote-to-production

on:
  release:
    types: [published]

permissions:
  contents: write

concurrency:
  group: promote-to-production
  cancel-in-progress: false

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout released tag
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name }}
          fetch-depth: 0

      - name: Fast-forward production to released tag
        run: |
          set -euo pipefail
          TAG="${{ github.event.release.tag_name }}"
          echo "Promoting $TAG to production"
          if git fetch origin "refs/heads/production:refs/remotes/origin/production" 2>/dev/null; then
            EXPECTED="$(git rev-parse refs/remotes/origin/production)"
            git push origin "$TAG:refs/heads/production" \
              --force-with-lease="refs/heads/production:$EXPECTED"
          else
            echo "production branch does not exist yet; creating it"
            git push origin "$TAG:refs/heads/production"
          fi
```

Notes:
- This workflow only fires when a release is **published by a human**, because GitHub does not trigger workflows from `GITHUB_TOKEN`-caused events. The Release Drafter workflow uses `GITHUB_TOKEN` to create/update the draft, so the draft creation itself does NOT fire this. Publishing the draft (a human action via the GitHub UI) DOES fire this.
- The lease form `--force-with-lease="refs/heads/production:$EXPECTED"` is the only documented non-experimental form. Bare `--force-with-lease` would degrade to plain force-push here because `actions/checkout@v4` with `ref: <tag>` doesn't fetch `refs/remotes/origin/production`.
- The first-promotion fallback (`production` doesn't exist on origin yet) does a plain create push.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/promote-to-production.yml
git commit -m "ci: add promote-to-production workflow"
```

---

## Task 4: Document the release flow in README

**Files:**
- Modify: `README.md`

Insert a new `## Releases` section AFTER `## Demo account` and BEFORE `## Deploy`.

- [ ] **Step 1: Add the section**

Body content:

```markdown
## Releases

Cashflow uses [Release Drafter](https://github.com/release-drafter/release-drafter)
to maintain a draft GitHub Release from merged PRs, plus a `production` branch
that Railway tracks for deployment.

**To ship to production:**

1. Open a PR with a conventional-commit title (`feat:`, `fix:`, `docs:`, etc.).
   Release Drafter auto-labels the PR based on the title prefix.
2. When the PR merges to `main`, Release Drafter updates the draft GitHub
   Release with a new entry under the matching category. The draft also
   suggests the next semver version (`feat:` → minor, `fix:` → patch,
   `feat!:` → major).
3. When ready to ship, go to **Releases → Drafts** in GitHub, eyeball the
   notes and version, edit if needed, click **Publish release**.
4. Publishing fires a `release: published` event (human action, not
   `GITHUB_TOKEN`). The `promote-to-production` workflow fast-forwards the
   `production` branch to the released tag. Railway, which tracks
   `production`, deploys.

`main` does not auto-deploy to prod. Only publishing a release advances
`production`.

**Version bumps (suggested by Drafter; override at Publish time):**
- `feat:` → minor bump
- `fix:` / `perf:` / `deps:` → patch bump
- `feat!:` or any title with `!` after the type → major bump
- `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` → fall to patch
  default; you choose whether to publish a release with only these

**Rollback:**

If branch protection isn't enabled on `production`:

```bash
git push origin <older-tag>:refs/heads/production --force-with-lease
```

If branch protection IS enabled (recommended; only `github-actions[bot]` can
push to `production`), this command will be rejected. Temporarily disable
the protection rule in **Settings → Branches**, run the push, then
re-enable. A dedicated `workflow_dispatch` rollback workflow that runs as
the bot is a cleaner long-term option but not currently configured.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document GitHub-managed release flow"
```

---

## Task 5: Enable required GitHub repo settings (manual, browser)

No code; settings only. Do this before the first PR is opened so the autolabeler can label it.

- [ ] **Step 1: Set workflow permissions**

Repo Settings → Actions → General → Workflow permissions:
- Select **Read and write permissions**
- Check **Allow GitHub Actions to create and approve pull requests**
- Save

- [ ] **Step 2: Verify via gh CLI**

```bash
gh api /repos/:owner/:repo/actions/permissions/workflow
```

Expected: `default_workflow_permissions: "write"`, `can_approve_pull_request_reviews: true`.

---

## Task 6: Create the production branch (one-time)

The branch must exist before Railway can be repointed to it.

- [ ] **Step 1: Update local main**

```bash
git checkout main
git pull origin main
```

- [ ] **Step 2: Create production from main HEAD**

```bash
git checkout -b production
git push -u origin production
```

- [ ] **Step 3: Confirm both branches point at the same commit**

```bash
git rev-parse main
git rev-parse production
```

Expected: identical SHAs.

- [ ] **Step 4: Return to main**

```bash
git checkout main
```

---

## Task 7: Reconfigure Railway to track production (manual, dashboard)

- [ ] **Step 1: Open the Cashflow Railway project**

- [ ] **Step 2: Change backend service tracked branch**

Backend service → Settings → Source → Branch: `main` → `production`. Save.

Railway either skips the redeploy (same commit) or does a no-op redeploy.

- [ ] **Step 3: Change frontend service tracked branch**

Same for frontend.

- [ ] **Step 4: Verify backend healthy**

```bash
curl -fsS https://<your-backend-railway-url>/api/health
```

Expected: HTTP 200, `{"ok": true, ...}`.

---

## Task 8: (Optional) Protect the production branch

- [ ] **Step 1: Add a branch protection rule**

Repo Settings → Branches → Add rule for `production`:
- Restrict who can push: allowlist `github-actions[bot]` only
- Allow force pushes, restricted to `github-actions[bot]`
- "Do not allow bypassing the above settings": enable
- Save

Requires GitHub Pro for private repos. Skip if your plan doesn't support it.

---

## Task 9: Trigger and verify the first end-to-end release

- [ ] **Step 1: Open and merge a feat or fix PR**

Make any real user-facing change in a PR with a conventional-commit title. Confirm the autolabeler tags it (e.g., a `feat:` title gets a `feature` label) before merging.

```bash
gh pr view <pr-number> --json labels
```

Expected: labels include the auto-applied label.

- [ ] **Step 2: Watch Release Drafter update the draft**

After the merge:

```bash
gh release list
```

Expected: a draft release exists with a `v0.X.Y` name. View its body:

```bash
gh release view <tag>
```

Expected: body contains an entry for your merged PR under the matching category.

- [ ] **Step 3: Publish the draft**

In the GitHub UI, **Releases → Drafts** → click the draft → **Publish release**. Confirm the tag name and version (edit if needed) before clicking.

- [ ] **Step 4: Watch promote-to-production fire**

```bash
gh run list --workflow=promote-to-production.yml --limit 1
gh run view --log
```

Expected: workflow `success`. Final step shows the force-with-lease push to `production`.

- [ ] **Step 5: Verify production advanced**

```bash
git fetch origin production
git log -1 --format='%H %s' origin/production
```

Expected: SHA matches the released tag.

- [ ] **Step 6: Verify Railway deployed**

Railway dashboard shows new deployments on both services. Health check responds.

---

## Verification checklist

After all tasks complete:

- [ ] `.github/release-drafter.yml`, `.github/workflows/release-drafter.yml`, `.github/workflows/promote-to-production.yml` all exist
- [ ] `git branch -r` shows both `origin/main` and `origin/production`
- [ ] Pushes to `main` no longer trigger Railway deploys
- [ ] Publishing a draft release in GitHub fires `promote-to-production` and advances `production`
- [ ] Railway deploys from `production`
- [ ] README's Releases section accurately describes the flow
