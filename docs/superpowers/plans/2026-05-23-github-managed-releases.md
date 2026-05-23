# GitHub-Managed Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Cashflow from "every push to `main` deploys to prod" to "merging a release PR cuts a version tag, which advances a `production` branch that Railway tracks for deployment."

**Architecture:** Two GitHub Actions plus one long-lived branch. `release-please` watches `main` for conventional commits and keeps an open release PR with the proposed version bump and CHANGELOG diff. Merging that PR creates a git tag and GitHub Release. A second workflow listens for `release: published` and fast-forwards the `production` branch to the tagged commit. Railway is reconfigured to deploy from `production` instead of `main`, so `main` pushes no longer touch prod — only Release-PR merges do.

**Tech Stack:** GitHub Actions, [`googleapis/release-please-action@v4`](https://github.com/googleapis/release-please-action), Railway's branch-tracking GitHub integration.

---

## File Structure

**Created:**
- `release-please-config.json` — bump rules, changelog sections, package layout
- `.release-please-manifest.json` — current version state read/written by release-please
- `.github/workflows/release-please.yml` — opens/updates the Release PR on every `main` push
- `.github/workflows/promote-to-production.yml` — fast-forwards `production` to the released tag on Release publish

**Modified:**
- `package.json` (root) — add `"version": "0.1.0"`
- `README.md` — add a Releases section

**One-time, non-file changes:**
- `production` git branch created from current `main` HEAD
- GitHub repo settings: workflow permissions + "allow Actions to create PRs"
- (Optional) branch protection rule on `production`
- Railway service config: change tracked branch from `main` to `production` on both backend and frontend services

---

## Out of Scope

- `GET /api/version` endpoint and a frontend footer badge ("versioning A" from earlier discussion). The version this plan bumps lives in `package.json`, git tags, and GitHub Releases — visible via `git log production` and the Releases tab. In-app visibility is a separate, additive concern.
- `/api/v1` URL prefix for API stability. Deferred until the vendor receipt bookmarklet (`docs/superpowers/specs/2026-05-22-vendor-receipt-capture-design.md`) ships and becomes a second client.

---

## Task 1: Initialize version in root package.json

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Add version field**

The root `package.json` currently has no `version` field. Add `"version": "0.1.0"` immediately after the `"name": "cashflow"` line.

After:

```json
{
  "name": "cashflow",
  "version": "0.1.0",
  "private": true,
  "packageManager": "yarn@1.22.22",
  ...
}
```

- [ ] **Step 2: Verify json is still valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json'))"
```

Expected: exits with no output (status 0).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: initialize root package version at 0.1.0"
```

---

## Task 2: Configure release-please

**Files:**
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`

- [ ] **Step 1: Capture current HEAD SHA for bootstrap**

```bash
git rev-parse HEAD
```

Note the full SHA output. This is `bootstrap-sha` for release-please — it ignores commits at or before this SHA, so the first release PR's CHANGELOG won't include the entire repo history.

- [ ] **Step 2: Create release-please-config.json**

Create `release-please-config.json` at the repo root with this content (substitute the SHA from Step 1):

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "bootstrap-sha": "PASTE_SHA_FROM_STEP_1_HERE",
  "include-component-in-tag": false,
  "include-v-in-tag": true,
  "separate-pull-requests": false,
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance" },
    { "type": "deps", "section": "Dependencies" },
    { "type": "revert", "section": "Reverts" },
    { "type": "docs", "section": "Documentation", "hidden": true },
    { "type": "chore", "section": "Miscellaneous", "hidden": true },
    { "type": "refactor", "section": "Code Refactoring", "hidden": true },
    { "type": "test", "section": "Tests", "hidden": true },
    { "type": "build", "section": "Build System", "hidden": true },
    { "type": "ci", "section": "Continuous Integration", "hidden": true }
  ],
  "packages": {
    ".": {
      "package-name": "cashflow"
    }
  }
}
```

`"hidden": true` means commits of those types appear in CHANGELOG but never trigger a release on their own. Only `feat:`, `fix:`, `perf:`, `deps:`, and `revert:` drive a version bump.

- [ ] **Step 3: Create .release-please-manifest.json**

```json
{
  ".": "0.1.0"
}
```

Must match the version in root `package.json` from Task 1.

- [ ] **Step 4: Validate both files are JSON-parseable**

```bash
node -e "JSON.parse(require('fs').readFileSync('release-please-config.json'))"
node -e "JSON.parse(require('fs').readFileSync('.release-please-manifest.json'))"
```

Expected: both exit cleanly.

- [ ] **Step 5: Commit**

```bash
git add release-please-config.json .release-please-manifest.json
git commit -m "chore: configure release-please"
```

---

## Task 3: Enable required GitHub repo settings (manual, browser)

No code; settings only. Do this BEFORE pushing the workflow in Task 4 so the very first workflow run has the permissions it needs.

- [ ] **Step 1: Set workflow permissions**

Open the repo on GitHub → **Settings** → **Actions** → **General** → scroll to **Workflow permissions**:

- Select **Read and write permissions** (default is read-only on many repos)
- Check **Allow GitHub Actions to create and approve pull requests**
- Click **Save**

Without both, release-please cannot open its release PR.

- [ ] **Step 2: Verify via gh CLI**

```bash
gh api /repos/:owner/:repo/actions/permissions/workflow
```

Expected JSON:

```json
{
  "default_workflow_permissions": "write",
  "can_approve_pull_request_reviews": true
}
```

If `default_workflow_permissions` is still `"read"`, return to Step 1.

---

## Task 4: Add release-please workflow

**Files:**
- Create: `.github/workflows/release-please.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: release-please

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/release-please.yml
git commit -m "ci: add release-please workflow"
git push origin main
```

- [ ] **Step 3: Verify the workflow ran successfully**

Wait ~30 seconds after the push, then:

```bash
gh run list --workflow=release-please.yml --limit 1
```

Expected: latest run shows `status: completed`, `conclusion: success`.

If `conclusion: failure`, debug with:

```bash
gh run view --log
```

Common failures:
- "Resource not accessible by integration" → Task 3 wasn't done correctly. Recheck Step 1 there.
- Config parse error → re-validate JSON from Task 2 Step 4.

- [ ] **Step 4: Confirm no Release PR opened (yet)**

```bash
gh pr list --label "autorelease: pending"
```

Expected: empty. At this point there are no `feat:`/`fix:` commits after `bootstrap-sha`, so release-please has nothing to release. That's correct — the workflow just runs and exits cleanly.

---

## Task 5: Add promote-to-production workflow

**Files:**
- Create: `.github/workflows/promote-to-production.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: promote-to-production

on:
  release:
    types: [published]

permissions:
  contents: write

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout release tag
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name }}
          fetch-depth: 0

      - name: Fast-forward production to released tag
        run: |
          set -euo pipefail
          TAG="${{ github.event.release.tag_name }}"
          echo "Promoting $TAG to production branch"
          git push origin "$TAG:refs/heads/production" --force-with-lease
```

Notes:
- `--force-with-lease` is safe here because release tags only move forward in time and no human should be pushing to `production` directly (Task 8 enforces this).
- If `production` ever diverges from the previous release tag (because someone pushed to it manually), `--force-with-lease` refuses — the right failure mode. Resolve by hand at that point rather than silently overwriting.

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/promote-to-production.yml
git commit -m "ci: add promote-to-production workflow"
git push origin main
```

- [ ] **Step 3: Verify workflow is registered**

```bash
gh workflow list
```

Expected: both `release-please` and `promote-to-production` appear in the output. `promote-to-production` will not have any runs yet — it only fires on Release publish.

---

## Task 6: Create the production branch (one-time bootstrap)

The branch must exist before Railway can be repointed to it.

- [ ] **Step 1: Ensure local main is up to date**

```bash
git checkout main
git pull origin main
```

- [ ] **Step 2: Create production from current main HEAD**

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

## Task 7: Reconfigure Railway to track production (manual, Railway dashboard)

Read all steps before doing any of them. Order matters to keep prod up.

- [ ] **Step 1: Open the Cashflow Railway project**

Navigate to the Cashflow project in the Railway dashboard.

- [ ] **Step 2: Change backend service tracked branch**

Backend service → **Settings** → **Source** → **Branch**:
- Change from `main` to `production`
- Save

Because `production` currently points at the same commit as `main`, Railway either skips a redeploy or runs a no-op redeploy of the same code.

- [ ] **Step 3: Change frontend service tracked branch**

Repeat for the frontend service: **Settings** → **Source** → **Branch** → `production`.

- [ ] **Step 4: Verify backend is still healthy**

After ~2 minutes:

```bash
curl -fsS https://<your-backend-railway-url>/api/health
```

Expected: HTTP 200 with `{"ok": true, ...}`. The deployed code is unchanged.

- [ ] **Step 5: (Optional) Verify main no longer auto-deploys**

Make any small commit to `main` (e.g. add a blank line to README), push, and watch Railway's deployments tab. Expected: no new deployment is triggered for either service. Revert the commit afterward if you don't want it in history (`git reset --hard HEAD~1 && git push --force-with-lease origin main` — only safe if no one else has pulled).

Skip this step if you'd rather not produce a throwaway commit. The behavior is verified end-to-end in Task 9.

---

## Task 8: (Optional) Protect the production branch

Branch protection prevents accidental local pushes to `production` from advancing prod outside the release flow. Requires GitHub Pro for private repos; available on any public repo.

- [ ] **Step 1: Add a branch protection rule**

Repo **Settings** → **Branches** → **Branch protection rules** → **Add rule**:

- Branch name pattern: `production`
- Enable **Restrict who can push to matching branches**
  - Allowlist: `github-actions[bot]` only
- Enable **Allow force pushes**, restricted to `github-actions[bot]`
- Enable **Do not allow bypassing the above settings** (prevents your owner-level override)
- Save

- [ ] **Step 2: (Sanity check, optional) Confirm direct pushes are blocked**

```bash
git checkout production
git pull
git commit --allow-empty -m "test: should be blocked"
git push origin production
```

Expected: push rejected with a branch protection error. Reset:

```bash
git reset --hard origin/production
git checkout main
```

If your GitHub plan doesn't support these options, skip this whole task. The release flow still works without protection — you just have to trust yourself (and any other repo collaborators) not to manually push to `production`.

---

## Task 9: Trigger and verify the first end-to-end release

This is the integration test. Two paths to choose from:

**Option A — wait for a real `feat:`/`fix:` commit on `main`.** Any user-facing change. Most authentic test, no temporary config.

**Option B — force a 0.1.0 release now via temporary `release-as` config.** Useful if you want to verify the chain immediately without waiting for real work.

Steps below cover Option A. For Option B, add `"release-as": "0.1.0"` to `release-please-config.json`, push as a `chore:` commit, run through the steps, then remove `release-as` and push again as a separate `chore:` commit.

- [ ] **Step 1: Push a feat or fix commit to main**

```bash
git checkout main
# (make a small, real, user-facing change)
git add <changed-files>
git commit -m "feat: <description>"
git push origin main
```

- [ ] **Step 2: Watch release-please open the Release PR**

```bash
gh run watch
```

When the run completes:

```bash
gh pr list --label "autorelease: pending"
```

Expected: one PR titled "chore(main): release X.Y.Z" with:
- `package.json` version bumped (e.g. 0.1.0 → 0.2.0 for a feat, 0.1.1 for a fix)
- `CHANGELOG.md` created or updated with an entry referencing your commit
- `.release-please-manifest.json` updated to the new version

If no PR appears, check the run log: `gh run view --log`.

- [ ] **Step 3: Merge the Release PR**

```bash
gh pr merge <pr-number> --squash --delete-branch
```

Use whichever merge style your repo prefers; release-please works with any.

- [ ] **Step 4: Verify tag + GitHub Release were created**

```bash
gh release list --limit 1
```

Expected: one release named `vX.Y.Z`.

```bash
gh release view vX.Y.Z
```

Expected: release body matches the CHANGELOG entry; tag points at the squash-merge commit on `main`.

- [ ] **Step 5: Watch promote-to-production fire**

```bash
gh run list --workflow=promote-to-production.yml --limit 1
gh run view --log
```

Expected: workflow `success`. Log's final step shows the force-with-lease push to `production` completed.

- [ ] **Step 6: Verify production branch advanced**

```bash
git fetch origin production
git log -1 --format='%H %s' origin/production
```

Expected: SHA matches the tag from Step 4. Subject is the Release PR's squash commit message.

- [ ] **Step 7: Verify Railway deployed**

In Railway dashboard, both services should show a deployment that just started or completed, sourced from the new tagged commit.

```bash
curl -fsS https://<your-backend-railway-url>/api/health
```

Expected: HTTP 200. The deployment logs in Railway should show the same SHA as in Step 6.

---

## Task 10: Document the release flow in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Releases section**

Open `README.md`. Insert the following new section after the **Demo account** section and before the **Deploy** section:

```markdown
## Releases

Cashflow uses [release-please](https://github.com/googleapis/release-please) to
manage versions from conventional commits, plus a `production` branch that
Railway tracks for deployment.

**To ship to production:**

1. Make changes on a feature branch; merge to `main` via PR with a conventional
   commit message (`feat:`, `fix:`, etc.). The prefix determines the next
   version bump.
2. `release-please` watches `main` and maintains an open release PR titled
   "chore(main): release X.Y.Z" with the proposed version bump and updated
   `CHANGELOG.md`.
3. When you're ready to ship, merge the release PR. This creates a git tag, a
   GitHub Release, and fast-forwards the `production` branch to the tagged
   commit.
4. Railway tracks `production` and deploys both backend and frontend services
   on each push.

`main` does not auto-deploy to prod. Only release-PR merges advance
`production`.

**Version bumps follow semver:**
- `feat:` → minor bump
- `fix:` / `perf:` / `deps:` → patch bump
- `feat!:` or any commit body containing `BREAKING CHANGE:` → major bump
- `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` → no bump; shown in
  CHANGELOG under hidden sections

**Rollback:**

```bash
git push origin <older-tag>:refs/heads/production --force-with-lease
```

Must be done by an account in the production branch protection allowlist (or
by anyone if protection isn't configured).
```

- [ ] **Step 2: Commit and push**

```bash
git add README.md
git commit -m "docs: document GitHub-managed release flow"
git push origin main
```

This is a `docs:` commit. It will appear in the next release's CHANGELOG under the (hidden) Documentation section but will not trigger a version bump on its own — confirming the policy works.

---

## Verification checklist

After all tasks complete, these should all be true:

- [ ] `package.json` (root) has `"version": "0.1.0"`
- [ ] `release-please-config.json` and `.release-please-manifest.json` exist at repo root and are valid JSON
- [ ] `.github/workflows/release-please.yml` and `.github/workflows/promote-to-production.yml` exist
- [ ] `git branch -r` shows both `origin/main` and `origin/production`
- [ ] Pushing to `main` runs CI but does NOT trigger a Railway deployment for either service
- [ ] At least one `vX.Y.Z` tag and matching GitHub Release exist
- [ ] `production` branch HEAD SHA matches the latest release tag's commit SHA
- [ ] Railway dashboard shows both services tracking `production`
- [ ] README's "Releases" section is present and accurately describes the flow
