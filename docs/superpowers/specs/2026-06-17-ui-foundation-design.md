# UI Foundation — Design Spec

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Sub-project:** 1 of N in the broader "clean every page" effort

## Problem

The app has bad UI across ~53 pages. Three concrete pains (user-confirmed):
inconsistency page-to-page, unpolished look, and poor layout/structure. *Not*
maintainability — the code structure is acceptable.

The root cause is **design-system drift, not a missing design system**:

- `frontend/src/components/ui/` already holds ~25 CVA-based primitives (button,
  card, badge, dialog, table, tabs, page-header, stat-card, metric-stat,
  empty-state, filter-bar, skeleton, …) plus strong dashboard primitives
  (`BentoTile`, `KpiStack`, `TableTile`).
- **But** `App.css` is 2,203 lines, ~95 files still reference raw classes
  (`.page`, `.muted`, `.row`, `.emptyState`), and 37 pages carry inline
  `style={{}}` blobs.

So a half-adopted primitive set competes with bespoke CSS and inline styles.
That competition *is* the inconsistency and ugliness.

### Reframe (load-bearing)

The chosen reference page — **DashboardPage** — is itself a hybrid: it uses the
good primitives **and** raw App.css classes (`budgetPill`, `businessFocusCard`)
**and** inline-style soup (the filter chip, `DashboardPage.tsx:784-801`).
Therefore:

> **Dashboard = the aesthetic north-star (how pages should LOOK).
> Hardened `ui/` primitives = the implementation target (how pages should be BUILT).**

Never conflate the two. "Match the Dashboard" means match its *polish*, not copy
its *implementation* — parts of its implementation are the disease.

## Goal

Establish an **objective, verifiable standard** for "clean", so every later
page-sweep is fast and not a matter of taste. Prove the standard against one real
page before committing to the other 52.

## Scope

**In scope (this sub-project):**
1. Read-only audit of existing `ui/` primitives.
2. A rules doc codifying spacing, page anatomy, typography, density, state
   patterns, and token-only color.
3. A living component gallery (new settings tab beside Palette).
4. One pilot page migrated end-to-end: **AccountsPage**.
5. A ranked worst-first backlog of the remaining 52 pages (produced, not executed).

**Explicitly out of scope (later sub-projects):**
- Refactoring primitive APIs (variants/props/token usage) — no call-site churn now.
- Dismantling `App.css` — only the slice the pilot touches is migrated.
- The other 52 pages.

## Components

### 1. Primitive audit (read-only)
Inventory every `components/ui/*` primitive: API surface, variants, token usage,
and **consumer count** (how many files import each — grounds the backlog signal:
high-consumer primitives are the highest-leverage to bless/harden). Deliverable: a
table `primitive → consumers → status (solid / inconsistent / gap)`. No code
changes. Expected gaps to name: a true **page
shell**, a **section** wrapper, **table density rules**, canonical
**loading/empty/error** usage.

### 2. Rules doc
Concrete and enforceable, derived from the Dashboard's existing good usage:
- **Spacing scale** — allowed gaps/margins (e.g. `gap-4`, `mt-2`, `space-y-6`);
  no arbitrary inline margins.
- **Page anatomy** — `PageHeader` → optional toolbar/filter row → content. One
  blessed structure.
- **Typography hierarchy** — h1 / section-label / body / muted, mapped to tokens.
- **Density** — table row height + padding; when `TableTile` vs raw `table`.
- **State patterns** — exactly one way each for loading, empty, error (replacing
  today's mix of `.emptyState`, `.muted`, and inline).
- **Color** — token utilities only; no hex, no raw `.muted` class in new code.

### 3. Living gallery
Extend the existing `PaletteSection`
(`frontend/src/pages/settings/sections/PaletteSection.tsx`) into a full **Design
System** settings section/tab. Renders every blessed primitive in every variant +
state, live against the active theme (reuses PaletteSection's runtime-token
reading pattern). This is the clickable north-star that makes "polished"
objective and surfaces drift visually. Lives in-app (theme-honest), not a
dev-only Storybook.

### 4. Pilot: AccountsPage
Migrate `frontend/src/pages/AccountsPage.tsx` (652 lines; 9 raw classes + 3
inline-style blobs) end-to-end to the rules.

**Definition of done:**
- Zero inline `style={{}}`.
- Zero bespoke App.css classes *that the rules cover* (any class the rules don't
  yet cover is logged as a rule gap, not silently left).
- Visually matches Dashboard-level polish.
- All existing AccountsPage tests stay green.

The pilot is the proof: it surfaces rule gaps before they cost 52× the rework.

### 5. Ranked sweep backlog
Worst-first ordered list of the remaining 52 pages (by inline-style + raw-class
count). Input to sub-project 2+. Produced here, **not executed**.

## Data flow / interfaces

No backend, no API changes. The gallery is a pure read of CSS tokens at runtime
(same `getComputedStyle` + `MutationObserver` pattern PaletteSection already
uses). The pilot swaps classNames/inline styles for primitives + Tailwind token
utilities; no behavior change.

## Testing

- **Gallery:** a render test asserting each primitive section mounts (extend
  `PaletteSection.test.tsx` or a sibling).
- **Pilot:** existing `AccountsPage` tests must pass unchanged — the migration is
  visual/structural, not behavioral. Add assertions only where a state pattern
  (empty/loading) changed shape.
- **Lint/type:** `yarn workspace frontend run lint` + frontend typecheck clean.

## Risks

- **Rule gaps discovered late.** Mitigated by the pilot — it runs *before* the
  backlog is executed, on purpose.
- **Gallery rot.** A primitive added later but not shown in the gallery silently
  drifts. Accept for now; a later sub-project can add a lint that flags
  ungalleried primitives.
- **Scope creep into App.css demolition.** Guard: only the pilot's touched slice
  moves; the 2,203-line teardown is a named later sub-project.

## Out-of-scope follow-ups (named, not committed)

- Sub-project 2+: execute the page-sweep backlog, worst-first.
- Primitive API hardening (consistent variants/props across `ui/`).
- App.css dismantling into tokens/primitives.
