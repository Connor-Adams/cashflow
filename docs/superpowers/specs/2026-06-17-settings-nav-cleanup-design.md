# Settings nav cleanup: vertical sidebar + IA regroup

**Status:** design approved 2026-06-17, ready for implementation plan
**Author:** Connor (via brainstorming session `settings-nav-cleanup`)
**Scope:** Frontend only. No backend, API, or data-model changes.
**Supersedes the unfinished parts of:** `docs/superpowers/specs/2026-05-23-settings-tabs-design.md`
(that spec proposed 5 top tabs; reality drifted to 18 tabs across two horizontal strips).

## Problem

The Settings page nav is four problems at once:

1. **Visual sprawl.** `SettingsPage.tsx` renders two stacked horizontal `Tabs`
   strips — Workspace (10 items) and Advanced (8) — that overflow/wrap. 18
   top-level tabs in a horizontal container do not scan.
2. **Junk drawer.** Half the items are not settings: Contacts, Categories,
   Labels, Saved filters are reference-data CRUD; Budgets is planning data;
   Enrichment is read-only insights. They were crammed under `/settings`.
3. **Inconsistent two-tier nav.** Only the "Settings" tab expands into a
   secondary horizontal sub-nav (`SettingsTabLayout`: Display, Palette, Design
   System, Gmail, Partner invite). Every other tab is flat. The nesting is
   arbitrary.
4. **Dead / confusing items.** A "Notifications" tab is declared in nav and in
   `TOP_TAB_PATHS` but has no page and no route — clicking it lands on a blank
   Outlet. Labels like "Backup & sync" are vague. Owner-only items (Feedback)
   vanish silently with no explanation.

## Goals

1. Replace the two horizontal tab strips **and** the Settings-only horizontal
   sub-nav with **one vertical, grouped sidebar** inside the Settings page.
2. Relocate the two data surfaces whose real home is elsewhere (Budgets,
   Enrichment) to the global sidebar; regroup the rest under honest headers.
3. Deep-link every destination; redirect every old path so refresh, bookmarks,
   and back/forward keep working.
4. Remove the dead Notifications tab; relabel vague items; surface owner-only
   gating instead of silently hiding.
5. Preserve all existing section behavior verbatim. Page merges = composing
   existing components on one route, not rewriting logic.

## Non-goals

- Refactoring any section's internal logic (Gmail OAuth, capture/reporting
  tokens, enrichment streaming, categories/labels/contacts/budgets CRUD all move
  or compose untouched).
- Touching backend routes, API contracts, or the data model.
- Redesigning the global sidebar beyond adding two entries.
- Building a real Notifications feature (the tab is removed, not implemented).
- Changing permission rules (Feedback stays owner-only; we only make the gating
  *visible*, we do not change who can see it).

## Information architecture

### Global sidebar (`components/Sidebar.tsx`) — two additions

- **Planning** group gains **Budgets** → `/budgets` (sits with Goals, Scenarios).
- **Insights & rules** group gains **Enrichment** → `/enrichment` (rule-adjacent,
  read-only).

No other global-nav changes. The Settings footer button is unchanged.

### Settings page — one vertical sidebar, three groups

```
CONFIGURATION
  Display          /settings/display
  Appearance       /settings/appearance      (merged: Palette + Design System)
  Gmail            /settings/gmail
  Partner invite   /settings/partner-invite
  Members          /settings/members

LIBRARY
  Categories       /settings/categories
  Labels           /settings/labels
  Contacts         /settings/contacts
  Saved filters    /settings/saved-filters

ADVANCED
  Jobs             /settings/jobs
  API tokens       /settings/api-tokens      (merged: AI audit + Reporting tokens)
  Audit log        /settings/audit-log
  Backup & export  /settings/backup          (relabeled from "Backup & sync")
  Feedback         /settings/feedback        (owner-only, with visible lock hint)
  What's new       /settings/whatsnew
```

Removed from Settings entirely: **Budgets** and **Enrichment** (relocated above),
and **Notifications** (dead, deleted).

## Components

| Component | Change |
|---|---|
| `pages/settings/SettingsSidebar.tsx` | **New.** Vertical grouped nav. Takes the group/item model, applies role filtering (owner-only Feedback rendered with a lock affordance, not hidden), highlights the active item via `useActiveSettingsTopTab`. Reuses existing design-system primitives — no new visual language. |
| `pages/settings/SettingsPage.tsx` | Becomes a thin shell: `PageHeader` + `<SettingsSidebar/>` + `<Outlet/>` in a two-column layout. Drops `WORKSPACE_TABS`/`ADVANCED_TABS`/`TOP_TAB_PATHS` (moved into the sidebar's group model) and the dual `<Tabs>` render. |
| `pages/settings/SettingsTabLayout.tsx` | **Removed.** Its five items fold into the single sidebar; the secondary horizontal sub-nav no longer exists. |
| `pages/settings/useActiveSettingsTopTab.ts` | Updated: drop `notifications`; add `appearance`, `api-tokens`; the active-state model now spans one flat path set, not top-tab + sub-tab. |
| `pages/settings/tabs/AppearanceTab.tsx` (or equiv) | **New.** Composes the existing Palette and Design System components on one route. No logic changes to either. |
| `pages/settings/tabs/ApiTokensTab.tsx` (or equiv) | **New.** Composes the existing AI-audit-tokens and reporting-tokens components on one route (e.g. two sections or an inner tab). No logic changes. |
| `components/Sidebar.tsx` | Add Budgets to Planning, Enrichment to Insights & rules. |
| `App.tsx` | Route tree updates + redirects (below). |

## Routing

### New / moved routes
- `/settings` index → redirect to `/settings/display` (unchanged behavior).
- `/settings/appearance` → AppearanceTab (replaces palette + design-system).
- `/settings/api-tokens` → ApiTokensTab (replaces audit-tokens + reporting-tokens).
- `/budgets` → existing Budgets component (moved out of settings).
- `/enrichment` → existing Enrichment component (moved out of settings).

### Redirects (preserve bookmarks / external links)
| Old path | New path |
|---|---|
| `/settings/palette` | `/settings/appearance` |
| `/settings/design-system` | `/settings/appearance` |
| `/settings/audit-tokens` | `/settings/api-tokens` |
| `/settings/reporting-tokens` | `/settings/api-tokens` |
| `/settings/budgets` | `/budgets` |
| `/settings/enrichment` | `/enrichment` |

### Removed
- `/settings/notifications` entry in `TOP_TAB_PATHS` and the `notifications`
  member of `SettingsTopTab`. (No route component existed.)

## Error handling / edge cases

- **Stale bookmarks** to any of the six old paths resolve via redirect, not a 404
  / blank Outlet.
- **Owner-only Feedback**: non-owners see the item rendered disabled with a lock
  hint (tooltip/aria-label), so the nav doesn't appear to silently drop items.
  The route itself stays guarded; backend `GET /api/feedback` already enforces.
- **Active highlight** must resolve correctly for merged routes — e.g. landing on
  `/settings/appearance` highlights Appearance; the old palette/design-system
  redirects settle there before highlight runs.

## Testing

- `useActiveSettingsTopTab`: returns the correct active key for each of the new
  flat paths, including `appearance` and `api-tokens`; no longer references
  `notifications`.
- Redirects: each of the six old paths lands on its new path (router-level test).
- `SettingsSidebar`: renders the three groups with correct items; owner-only
  Feedback hidden-vs-locked per role; active item highlighted.
- Merged pages: AppearanceTab renders both palette and design-system content;
  ApiTokensTab renders both token sections — assert key elements from each
  pre-existing component are present (guards against a merge dropping content).
- Global `Sidebar`: Budgets appears under Planning, Enrichment under Insights &
  rules.

## Migration / rollout

Single PR, frontend-only. No data migration. No feature flag — the redirect set
makes the cutover safe for any in-flight bookmark. CI (`yarn ci`) is the gate.
