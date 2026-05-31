# Living Changelog — Design

Date: 2026-05-30
Status: Approved (brainstorming) → ready for implementation plan
Related: GitHub issue #294 (in-app What's New surface), Release Drafter pivot (2026-05-23)

## Problem

Cashflow ships many PRs per day (largely AI-generated, each with a rich `## Summary` /
`## What's included` / `## Design notes` body). The only changelog is the GitHub Release
that Release Drafter assembles, and it is a flat list of PR **titles**:

```
- feat(debt): add debt payoff planner (#412) by @Connor-Adams
```

The terse title list has no color, and the rich PR bodies — the actual story of what shipped
and why — are discarded. There is also no in-app way to discover what changed (issue #294 is
open and unbuilt). The result: features land silently, and even the author loses the thread of
what the app has become.

## Goal

A **living changelog** that fuses the existing changelog (release → PR list) with the PR body
text into readable narrative, surfaced **two ways**:

1. **In-app (primary)** — a "What's New" surface inside cashflow: an evolving **overview**
   ("what the app does now") pinned above a **per-release feed** of plain-English entries, with
   a TopBar badge and modal. This is issue #294, extended with the overview.
2. **Richer GitHub Release notes (secondary, "nice")** — the same synthesized narrative
   written back into the Release body.

## Architecture: two layers

The system splits cleanly into a **generation layer** (new) and a **delivery layer** (issue
#294). The generation layer's output format *is* the delivery layer's input contract, so they
compose without coupling.

```
 Release (tag + PR list)              GENERATION LAYER                 DELIVERY LAYER (#294)
 ┌──────────────────────┐   ┌───────────────────────────────┐   ┌────────────────────────────┐
 │ Release Drafter body │──▶│ scripts/changelog-sync         │──▶│ docs/changelog/*.md         │
 │  (#NNN, #NNN …)       │   │  • resolve PRs in release      │   │  (overview.md + per-release)│
 │ PR bodies (gh api)   │──▶│  • Anthropic synthesis         │   │            │                │
 └──────────────────────┘   │    - feed entry (structured)   │   │            ▼                │
                            │    - overview (incremental)    │   │ backend/services/changelog  │
                            │  • write markdown              │   │  read → sanitize → render   │
                            │  • (2nd sink) rewrite release  │   │            │                │
                            └───────────────────────────────┘   │            ▼                │
                                          │                      │ GET /api/changelog,/latest, │
                                          ▼                      │     /overview  + PATCH prefs │
                                  GitHub Release body            │            │                │
                                  (rich narrative)               │            ▼                │
                                                                 │ TopBar badge · modal ·      │
                                                                 │ Settings → What's New tab   │
                                                                 └────────────────────────────┘
```

Key property: **the app holds no GitHub or Anthropic token at runtime.** Synthesis happens at
release time in a script; the app only reads committed markdown. LLM prose is therefore
version-controlled, diffable, and reviewable in a PR before it reaches the user (or partner).

## The contract: `docs/changelog/`

Single source of truth. The generation layer writes it; the delivery layer reads it.

```
docs/changelog/
  overview.md          # kind: overview — re-synthesized each release, pinned at top of the tab
  v0.13.52.md          # one file per release tag
  v0.13.51.md
  …
```

**Feed entry** (`docs/changelog/<tag>.md`):

```yaml
---
version: v0.13.52
title: "Debt planning, household sharing, and smarter imports"
publishedAt: 2026-05-30T01:22:39Z   # release published time
audience: user                      # user | operator
---
<plain-English narrative paragraph, then themed highlight bullets>
```

**Overview** (`docs/changelog/overview.md`):

```yaml
---
kind: overview
updatedAt: 2026-05-30T01:22:39Z
---
<"what cashflow does now" narrative, re-synthesized each release>
```

### Versioning and ordering (refinement over #294)

#294 keyed entries by a `YYYY-MM-DD-n` string and compared lexicographically. We change this:

- **Identity** = the release tag (`v0.13.52`).
- **Ordering** = `publishedAt` (the release's published timestamp), **not** lexicographic on the
  tag. Semver tags sort wrong as strings (`v0.13.9 > v0.13.52` lexically). `publishedAt` is
  monotonic and correct.
- **Badge / "unread"** = there exists a `user`-audience entry whose `publishedAt` is newer than
  the entry identified by the user's `last_seen_changelog_version` (or the user has none).
  This decouples the badge from the running build version.
- **`since` semantics** — `GET /api/changelog?since=<tag>` returns entries with `publishedAt`
  greater than the `publishedAt` of `<tag>`.
- **PATCH validation** — `last_seen_changelog_version` must match `^v\d+\.\d+\.\d+$`
  (replaces #294's date-format regex in AC #7).

## Generation layer: `scripts/changelog-sync`

A standalone Node script (run at release time, not part of app runtime). It uses the repo's
existing `@anthropic-ai/sdk` dependency and the same `ANTHROPIC_API_KEY` + model env the backend
uses — it does **not** import backend internals (keeps it decoupled, no backend build step).

Per-release flow:

1. **Resolve PRs in the release.** Primary: parse the GitHub Release body for every `#<number>`
   (Release Drafter emits `- $TITLE (#$NUMBER) by @$AUTHOR`, and lines may carry multiple refs,
   e.g. `(#373) (#382)` — extract all, dedup). Fallback: `git log <prev tag>..<tag>` and map
   commits → PRs.
2. **Fetch each PR** via `gh api repos/:owner/:repo/pulls/:n` → title, body, labels, author,
   mergedAt.
3. **Synthesize (Anthropic):**
   - **Feed entry** — structured output `{ title, summary, highlights[], audience }` → assembled
     deterministically into the entry markdown. Tone: plain-English, partner-readable, no
     conventional-commit jargon (`fix(scope):`). PRs whose labels are purely `chore`/`ci`/
     `build`/`test`/`dependencies` are marked `audience: operator` (hidden from the UI).
   - **Overview** — incremental: previous `overview.md` + this release's entry → updated
     overview. Bounded context (does not re-read the entire history each run).
4. **Write** `docs/changelog/<tag>.md` and `docs/changelog/overview.md`.
5. **(Secondary sink)** rewrite the GitHub Release body: narrative on top, Release Drafter's raw
   PR list + "Full Changelog" link preserved below (`gh release edit <tag> --notes …`).
6. **Modes:** `--dry-run` (print, no writes), default (write files), `--pr` (open a PR with the
   docs changes). Idempotent — re-running a tag overwrites that tag's file.

Failure handling: a missing PR body falls back to the title; an Anthropic failure exits non-zero
and writes nothing (never commits half-synthesized garbage).

## Delivery layer: issue #294 + overview extension

Built to #294's spec, with the overview added. (#294 carries the full acceptance criteria, UX
states, copy, and test plan; this section records the deltas.)

- **Migration** — `user_preferences.last_seen_changelog_version VARCHAR(64) NULL`, reversible.
- **Service** `backend/src/services/changelog.ts` — read `docs/changelog/`, parse front matter,
  render markdown → **sanitized** HTML (strip `<script>`, `on*` handlers — no XSS), split
  `kind: overview` from feed, sort feed by `publishedAt` desc, filter `operator` for user
  queries. Graceful degradation if the directory is missing/malformed (empty result, app still
  mounts).
- **Routes** `backend/src/routes/changelog.ts`:
  - `GET /api/changelog?since=<tag>&audience=user` → newer-than entries, newest first.
  - `GET /api/changelog/latest?audience=user` → single newest user entry or `{ empty: true }`.
  - `GET /api/changelog/overview` → the rendered overview, or `{ empty: true }`. **(new)**
  - `PATCH /api/preferences` `{ lastSeenChangelogVersion }` → persists; `400 INVALID_VERSION` on
    bad format.
- **Frontend:**
  - `TopBar` — "What's new" pill/badge when an unread user entry exists.
  - `ChangelogModal` — renders the latest entry; "Got it" PATCHes the preference and dismisses.
  - `WhatsNewTab` (Settings) — **overview pinned at top**, then the per-release feed list (title,
    publishedAt, rendered HTML). Empty state: "No release notes yet."

## Error handling (summary)

| Layer | Condition | Behavior |
|-------|-----------|----------|
| Engine | PR body missing | Fall back to PR title |
| Engine | Anthropic call fails | Exit non-zero, write nothing |
| Backend | `docs/changelog/` missing/malformed | Empty list, app mounts (AC #12) |
| Backend | markdown contains HTML | Sanitized (no `<script>`/`on*`) (AC #4) |
| Backend | `audience: operator` entry | Excluded from user queries (AC #5) |
| Frontend | changelog fetch fails | Silent, no badge (non-critical surface) |

## Testing

- **Engine (unit):** PR-resolution parser (release body → deduped PR numbers, multi-ref lines);
  feed-entry markdown assembly; overview update. **Anthropic is mocked** — no live calls in tests.
- **Backend (integration):** #294's plan — `/latest`, `/since` ordering, operator exclusion,
  markdown sanitization (script input → no script output), PATCH valid/invalid, missing dir —
  plus `/overview`.
- **Frontend (component):** badge visibility logic, modal "Got it" PATCH + dismiss, Settings tab
  lists entries + overview, empty state.

## Phasing

Delivery-first (decided). Each phase is its own PR(s) and is independently valuable.

- **P1 — Delivery core (#294).** Migration, service, routes (`/changelog`, `/latest`, PATCH),
  TopBar badge, modal, Settings tab — reading hand-written markdown, shipped with one starter
  entry. Brings the in-app surface (the primary goal) live fastest and validates the contract.
- **P2 — Overview extension.** `overview.md`, `GET /api/changelog/overview`, pinned render in the
  tab.
- **P3 — Generation engine.** `scripts/changelog-sync` synthesizes feed entries + overview from
  PR bodies, replacing hand-authoring.
- **P3b — Release-body rewrite.** Engine writes the narrative back into the GitHub Release
  (secondary sink).

## Decisions

1. **Phasing order — delivery-first.** Ship the in-app surface with a hand-written entry first,
   then automate with the engine. Validates the markdown contract before the LLM fills it; lowest
   risk; gets the primary goal live soonest.
2. **Engine trigger — manual-first.** Run `yarn changelog:sync` before publishing a release; the
   docs changes land as a PR you review, then you publish. Full review gate before the partner
   sees synthesized prose. CI-on-`release: published` automation can come later.
3. **Engine is decoupled from the backend.** Standalone script calling `@anthropic-ai/sdk`
   directly with the shared `ANTHROPIC_API_KEY`/model env, not importing backend code — so it has
   no backend build dependency and never runs in the request path.

## Out of scope

- Per-user changelog (only features you use), localization, RSS/Atom export, in-app authoring UI
  — all per #294's out-of-scope.
- CI automation of the engine (manual-first; deferred).
- Real-time / on-demand synthesis in the backend (rejected: would put GitHub + Anthropic tokens
  and cost/latency into the app, and remove the review gate).
