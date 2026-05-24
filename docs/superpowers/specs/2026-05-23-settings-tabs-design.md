# Settings page: tabs + sidebar restructure

**Status:** design approved 2026-05-23, ready for implementation plan
**Author:** Connor (via brainstorming session `settings-ui-tabs`)
**Scope:** Frontend only. No backend, API, or data-model changes.

## Problem

`frontend/src/pages/SettingsPage.tsx` is a 2,198-line single-scroll page holding 9 unrelated sections. Three of those nine aren't configuration at all — Enrichment dashboard is read-only insights, Contacts ledger and Monthly budgets are data CRUD surfaces. The page is hard to scan, hard to maintain, and conflates settings with data.

## Goals

1. Split the page into discoverable groups via top-of-page tabs.
2. Keep true settings under a "Settings" top tab, with a vertical sub-nav listing its sub-sections.
3. Deep-link every tab and sub-section so refresh, bookmarks, and browser back/forward all work.
4. Decompose the file: every tab and every Settings sub-section gets its own component file.
5. Preserve all existing behavior verbatim — no functional changes to any section.

## Non-goals

- Refactoring any section's internal logic (Gmail OAuth, capture tokens, enrichment streaming, contacts/budgets CRUD all move untouched).
- Touching backend routes or API contracts.
- Normalizing `PageHeader` usage across other pages (a known consistency gap, but out of scope here).
- Visual redesign beyond what the tabs/sidebar primitives produce.
- Permission gating changes (the only role check today is a display-only "God mode" badge).

## Information architecture

Five top tabs. The first ("Settings") expands into a left vertical sub-nav with three items. The other four are full-width content panes.

```
Top tabs:   [ Settings  |  Imports  |  Enrichment  |  Contacts  |  Budgets ]

When "Settings" tab is active:
  ┌──────────────────┬────────────────────────────────────────┐
  │ Display          │                                        │
  │ Gmail            │           (active sub-section)         │
  │ Partner invite   │                                        │
  └──────────────────┴────────────────────────────────────────┘

When any other top tab is active: full-width content, no sidebar.
```

### Mapping from current sections

| Current section (in today's SettingsPage.tsx) | New location |
|---|---|
| Display width | Settings tab → Display |
| Connect Gmail (OAuth + scan + allowlist) | Settings tab → Gmail |
| Partner invite | Settings tab → Partner invite |
| Import receipts (paste, image upload, CSV) | Imports tab (top half) |
| Receipt capture (token mint + bookmarklets) | Imports tab (bottom half) |
| Enrichment dashboard (stats) | Enrichment tab (top half) |
| Enrichment maintenance (backfill controls, flags) | Enrichment tab (bottom half) |
| Contacts ledger | Contacts tab |
| Monthly budgets | Budgets tab |

The Imports tab and Enrichment tab each render two existing Card blocks stacked. No logic merge — the sections remain conceptually distinct, just grouped under one tab heading.

## Routing

Path-segment routing via `react-router-dom` nested children.

```
/settings                  → <Navigate to="display" replace />
/settings/display          → SettingsTabLayout > DisplaySection
/settings/gmail            → SettingsTabLayout > GmailSection
/settings/partner-invite   → SettingsTabLayout > PartnerInviteSection
/settings/imports          → ImportsTab
/settings/enrichment       → EnrichmentTab
/settings/contacts         → ContactsTab
/settings/budgets          → BudgetsTab
```

`App.tsx` replaces the single `<Route path="settings" element={<SettingsPage />} />` line with a nested block. The outer `SettingsPage` renders the page header, top tabs, and an `<Outlet />`. The three Settings sub-routes share a `SettingsTabLayout` parent that renders the left sub-nav and its own `<Outlet />`.

The "Settings" top tab is marked active whenever `useMatch('settings/display')`, `useMatch('settings/gmail')`, or `useMatch('settings/partner-invite')` returns truthy. Centralize this in a small helper `useActiveSettingsTopTab()` colocated with the shell at `frontend/src/pages/settings/useActiveSettingsTopTab.ts`.

Top-tab click → `navigate('/settings/<slug>')`. Sub-nav `NavLink` provides its own active styling.

## File layout

New tree under `frontend/src/pages/settings/`:

```
SettingsPage.tsx              # outer shell: PageHeader + top Tabs + <Outlet />
SettingsTabLayout.tsx         # left sidebar + <Outlet />, mounted for Settings sub-routes only
sections/
  DisplaySection.tsx          # ~60 lines, radio group for display width
  GmailSection.tsx            # ~250 lines, OAuth + scan + allowlist
  PartnerInviteSection.tsx    # ~40 lines, generate + copy invite link
tabs/
  ImportsTab.tsx              # Import receipts + Receipt capture cards stacked
  EnrichmentTab.tsx           # Enrichment dashboard + maintenance cards stacked
  ContactsTab.tsx             # ~250 lines, contact form + grid
  BudgetsTab.tsx              # ~200 lines, budget form + table
```

The old `frontend/src/pages/SettingsPage.tsx` is deleted. The new `pages/settings/SettingsPage.tsx` replaces it. Import path in `App.tsx` updates accordingly.

Line counts above are estimates from the current code; the extraction is mechanical, so they should land close.

## Components

### `SettingsPage.tsx` (shell)

Renders:
1. `<PageHeader title="Settings" subtitle={household + email} />` (replaces today's bespoke header div).
2. Top `<Tabs items={topTabItems} value={activeTop} onValueChange={onTopChange} />`.
3. `<Outlet />`.

State: none. Active top tab is derived from the URL via `useActiveSettingsTopTab()`. `onTopChange` calls `navigate(`/settings/${value}`)`. For the "settings" top tab, navigate to `/settings/display` (the first sub-section).

### `SettingsTabLayout.tsx` (Settings-tab wrapper)

Renders a two-column flex layout:
- Left: a `<nav aria-label="Settings sections">` containing three `NavLink`s. Styling mirrors the global `Sidebar` BEM pattern (`settingsSubnav`, `settingsSubnav__link`, active modifier) but lives in its own CSS module to keep concerns separate.
- Right: `<Outlet />`.

At ≤768px the layout collapses: the sub-nav becomes a horizontal scrollable pill row above the content.

### Section / tab components

Each section component holds the JSX + state + handlers extracted verbatim from the current monolith. They:
- Receive no props (they're route leaves).
- Use their own `useState`, `useEffect`, and fetch calls — no shared state with siblings.
- Continue to use the existing `Card`, `Button`, `Input`, etc. primitives.
- Are self-contained for testing (each can be unit-tested in isolation via `react-router-dom/MemoryRouter`).

## Visual / interaction details

- **Tabs primitive.** Reuse `frontend/src/components/ui/tabs.tsx` unchanged. Pass `topTabItems = [{value:'settings', label:'Settings'}, ...]`. The segmented-control look may feel small at top-of-page width; if it does in practice, we add a `variant="page"` modifier in a follow-up — not in scope here.
- **Top tabs container.** Sits in the page shell, just under `PageHeader`, with horizontal padding matching the existing page gutter. Wrapper uses `overflow-x: auto` so it scrolls on narrow viewports instead of wrapping; the `Tabs` primitive's `flex-wrap` is overridden via a wrapper class.
- **Left sub-nav.** Vertical, fixed-width (~200px), border-right separator. `NavLink` active state uses the same visual treatment as the global sidebar's `isActive` modifier (background + accent text).
- **PageHeader title.** Stays `"Settings"` for the entire `/settings/*` tree. Tab labels provide secondary orientation; we don't dynamically rewrite the page title per sub-route.

## Backward compatibility

- `/settings` → redirects to `/settings/display` via index route `<Navigate to="display" replace />`.
- No other internal links target sub-sections (the page is single-route today). Global sidebar's "Settings" `NavLink` still points to `/settings` and lands users on Display.
- External bookmarks to `/settings` continue to work unchanged.

## Testing

The current `SettingsPage.tsx` has no colocated tests (confirmed via filesystem search), so this is net-new coverage rather than a migration.

- **Routing tests** (`SettingsPage.test.tsx`): mount `<MemoryRouter initialEntries={['/settings/contacts']} />`, assert `ContactsTab` renders and the Contacts top tab carries `aria-selected="true"`. One assertion per top tab.
- **Sub-nav tests** (`SettingsTabLayout.test.tsx`): navigating between `/settings/display`, `/settings/gmail`, `/settings/partner-invite` updates the active `NavLink` and swaps the outlet content.
- **Index redirect** (`SettingsPage.test.tsx`): mount at `/settings`, assert that `<Navigate>` resolves to `/settings/display`.
- **Section smoke tests**: each extracted section/tab gets a render test asserting its primary form fields and CTAs are present. We do not unit-test internal API logic — that's preserved verbatim from the current page and has no test coverage today (acknowledged gap, not regression).

`frontend/src/components/ui/localPrimitives.test.tsx` already covers the `Tabs` primitive itself — no new primitive tests needed.

## Risks

1. **CSS specificity.** The current page uses a mix of CSS modules and Tailwind utilities. The new sub-nav adds a small custom CSS surface. Risk: visual drift if class names collide. Mitigation: scope new styles via CSS module imports, same pattern the rest of the page uses.
2. **Segmented-control look.** As noted above, the existing `Tabs` may feel small as a top-of-page nav. Acknowledged trade-off; revisit only if it ships and feels wrong.
3. **Behavior drift during extraction.** Moving 2,198 lines into ~10 files is mechanical but easy to subtly break (lost effect dependency, mis-scoped state). Mitigation: extract one section at a time; each extraction step ends with a working build and a passing smoke test for that section.

## Out of scope (explicit)

- `PageHeader` audit / normalization across other pages.
- Mobile drawer for the in-page sub-nav (we use stacked pills instead — simpler).
- Visual variants of the `Tabs` primitive.
- Any change to section internals.
- Permission gates.
- Backend API changes.

## Acceptance criteria

- All 9 current sections remain reachable and functionally identical.
- Each top tab and each Settings sub-section has its own URL.
- Refresh and browser back/forward preserve the active view.
- `frontend/src/pages/settings/SettingsPage.tsx` is under 100 lines.
- No section file exceeds ~300 lines.
- The old monolithic `frontend/src/pages/SettingsPage.tsx` is deleted.
- Existing tests pass; new routing tests cover tab navigation.
