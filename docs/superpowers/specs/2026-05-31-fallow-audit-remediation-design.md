# Fallow audit remediation — design

**Date:** 2026-05-31
**Status:** Approved, decomposed into GitHub issues
**Scope chosen:** Dead code + Duplication (complexity explicitly excluded)
**Goal chosen:** Ratchet the audit toward a blocking gate

## Background

Cashflow runs [fallow](https://github.com/fallow-rs/fallow) (`fallow-rs/fallow@v2`)
as its static-analysis engine — *not* a Claude-based audit. It surfaces through two
CI mechanisms:

1. **`.github/workflows/fallow.yml`** — runs `fallow audit` on every PR with
   `diff-filter: added`, posts inline review comments on changed lines.
   `fail-on-issues: false` today, so it never blocks.
2. **`ci.yml` `code-audit` job** — runs `fallow dead-code` + `fallow health` + `jscpd`,
   renders a sticky whole-repo summary comment via `scripts/audit-summary.cjs`.
   Informational only.

The `code-audit` job carries an explicit intent in its own comment:

> *"Informational for now … Flip the steps to required once the baseline is driven down."*

No baseline or ratchet file exists yet. This work drives the baseline down and adds
the ratchet that intent calls for.

### Current snapshot (stable across PRs #457–459)

Health grade **C (65.7/100)**.

| Bucket | Findings | Zeroable? |
|---|---|---|
| Unused files | 5 | ✅ |
| Unused exports | 54 | ✅ |
| Unused exported types | 72 | ✅ |
| Unused class members | 7 | ✅ |
| Duplicate exports | 3 | ✅ |
| Unused dependencies | 1 | ✅ |
| Unlisted dependencies | 2 | ✅ |
| Circular dependencies | 7 | ✅ |
| Complexity | 488 critical · 312 high · 543 moderate (max cyclomatic 113, 15,699 fns) | ❌ reduce only |
| Duplication (jscpd) | 565 clones, 4.77% (worst: typescript 5.56%) | ❌ reduce only |

Config in `.fallowrc.json` already suppresses 4 dependencies and `Model` class
members, with `ignoreExportsUsedInFile: true`.

## Strategy

**You can only gate what you can hold at a line.** This single constraint shapes the
whole plan:

- **Dead-code categories** can be driven to **0** and *held* at 0 → become a hard block.
- **Duplication** cannot hit 0, but a **% ceiling** can be held → non-regression gate.
- **Complexity** has 488 critical findings; no realistic line to hold → stays
  informational, never blocks. It is out of scope by explicit choice.

**Stop the bleeding before bailing the boat.** The cheapest, highest-leverage move is
to flip `fallow.yml` to `fail-on-issues: true` so the audit blocks **new** dead-code
and duplication *introduced in a diff* (`diff-filter: added` already scopes it to
changed lines, so the existing backlog does not trip it). This lands first and
independently — it prevents the backlog from growing while everything else burns it
down. The whole-repo "make required" gate lands *last*, only after the zeroable
categories actually reach zero.

## Issue decomposition

Each issue is one mergeable PR, sized for `cashflow-tackle` / `cashflow-issue-worker`.
Acceptance is reproducible via the existing scripts (`yarn deadcode`, `yarn health`,
`yarn audit:code`) — issues specify *targets*, not a frozen finding list that would go
stale.

### Phase 1 — stop the bleeding (no backlog dependency)

#### #A — Changed-lines gate
Flip `fallow.yml` `fail-on-issues: true`, scoped per rule category:
dead-code → **block**, duplication → **block**, complexity → **warn**.

- **AC:** A PR that adds an unused export / new dead code on changed lines fails the
  Fallow check. A PR that adds a complex-but-clean function does **not** fail. The
  existing backlog does not cause failures (verify `diff-filter: added` only evaluates
  added lines).
- **Open detail:** Confirm `fallow@v2` supports per-rule severity in `.fallowrc.json`.
  If it is all-or-nothing, narrow the audited rule set (e.g. run with only
  dead-code + duplication rules enabled) so complexity does not block.

### Phase 2 — burn down the backlog (all independent, parallelizable)

#### #B — Dependency hygiene
Add the 2 unlisted dependencies (latent install/hoisting bug); remove the 1 unused one.

- **AC:** `yarn deadcode` reports `unused_dependencies = 0` and
  `unlisted_dependencies = 0`. Unlisted deps land in the correct `package.json`
  (root vs workspace). Unused dep removed, or suppressed in `.fallowrc.json`
  `ignoreDependencies` with a one-line justification if it is a genuine false positive
  (types-only / peer). Build + tests green.

#### #C — Unused files
Resolve all 5 unused files with a **per-file disposition**, recorded in the PR body:
delete (truly dead) / wire-up (orphaned-but-wanted) / suppress (intentional entry).

- The 5: `backend/src/ai/receiptVision.ts`, `frontend/src/components/import/UploadCard.tsx`,
  `frontend/src/pages/MerchantPage.tsx`, `frontend/src/theme/colors.ts`,
  `shared/categoryIcons.ts`.
- **Lead:** `MerchantPage.tsx` was committed 2026-05-26 "wired from txn rows + dashboard"
  and likely lost its route in the recent nav tab-fold refactor (#456–459). If still
  wanted, re-route it rather than delete. `theme/colors.ts` is likely superseded by the
  Tailwind theme.
- **AC:** `yarn deadcode` reports `unused_files = 0`. No dangling imports. Tests pass.
  **Do not blind-delete** — several files are recent feature work.

#### #D — Unused exports / types / duplicate exports / class members
Trim 54 unused exports + 72 unused types + 3 duplicate exports + 7 unused class members.

- **AC:** those four categories all report 0. Genuine public API / framework-required
  surface is suppressed via `// fallow-ignore-*` with a one-line reason; everything else
  is deleted. Typecheck + tests pass. May split into backend / frontend PRs if one PR
  is unwieldy.

#### #E — Circular dependencies
Break the 7 import cycles (extract shared types / invert a dependency).

- **AC:** `yarn deadcode` reports `circular_dependencies = 0`. No runtime behavior
  change. PR body documents each cycle and how it was broken. Higher risk —
  architectural; keep changes mechanical.

#### #F — Duplication
Extract the highest-value clone groups, starting with fallow's inline-flagged ones
(e.g. `frontend/src/pages/DashboardPage.tsx` clone groups).

- **AC:** jscpd total duplication drops below a defined ceiling (target ≤ 4.0%, down
  from 4.77%). Extract where the duplicated behavior should evolve together; leave
  accidental similarity. PR records before/after %.

### Phase 3 — lock it (depends on #B–#F reaching targets)

#### #G — Baseline ratchet + make `code-audit` required
Add a baseline comparison that fails a PR if any zeroable dead-code category > 0 or
dup% regresses above the #F ceiling; complexity stays informational. Flip the
`code-audit` job to required and update `CONTRIBUTING.md`.

- **AC:** PR introducing dead code (any zeroable category) or pushing dup% above the
  ceiling fails CI. Complexity findings never block. `code-audit` is a required check.
  `CONTRIBUTING.md` documents the gate. **Depends on #B, #C, #D, #E, #F merged.**

## Dependency graph

```
#A  (independent — land first)
#B  #C  #D  #E  #F   (independent of each other — parallel)
                 \
                  └── #G  (needs #B #C #D #E #F)
```

## Explicitly out of scope

- **Complexity refactors** (488 critical, max cyclomatic 113) — excluded by choice;
  stays informational indefinitely or until a separate, dedicated effort.
- No blind deletion of recent feature files.
- No unrelated refactoring beyond what each cycle/clone fix requires.

## End state

Once #A–#G land: new dead code and duplication are blocked at the diff on every PR;
the eight zeroable dead-code categories sit at 0 and are held there by a required check;
duplication is capped at a ratcheted ceiling; complexity remains a visible-but-advisory
health signal. The audit moves from "informational comment people scroll past" to "a
gate that keeps the baseline from regressing."
