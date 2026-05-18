# UI Overhaul: Wander DS + Light/Dark Theming

**Goal:** Improve visual polish and professional appearance with vibrant accent colors, clean spacing, and light/dark mode support.

## Color Strategy

**Dark Mode (Default):**
- Background: Deep charcoal/navy foundation
- Accents: Electric blue (primary), vibrant purple (secondary), warm orange (warnings/alerts)
- Text: Clean white/light grays with proper contrast
- All colors sourced from Wander DS semantic tokens

**Light Mode:**
- Background: Clean whites and light grays
- Accents: Toned-down versions of dark mode accents (same hues, lower saturation)
- Text: Dark gray/near-black for readability
- Consistent token names across both themes

## Theming Architecture

**Implementation:**
- CSS custom properties (--primary, --accent, --background, etc.) defined at `:root`
- Theme context/provider in React to manage state
- Root element gets `[data-theme="dark"]` or `[data-theme="light"]` attribute
- All color variables re-evaluated based on data-theme value

**User Control:**
- Toggle button in header (sun/moon icon)
- Theme preference saved to localStorage
- Respects system preference on first visit

**Migration Path:**
- App.css gets new theme variable sets (dark + light)
- Existing custom classes updated to use new tokens
- No breaking changes to component structure

## Component Migration

**Wander DS Integration:**
Replace custom implementations with Wander DS components where available:
- Buttons: `import { Button } from "@wandercom/design-system-web"`
- Cards: Use Wander Card component
- Inputs/Selects: Leverage Wander form elements
- Typography: Use Wander heading/text components

**Scope:** Focus on high-traffic areas first (auth page, dashboard, main layout). Page-specific components stay as-is; gradually migrate on refactoring.

**Component Tokens:**
All Wander components use semantic tokens automatically — color switching is automatic when theme changes.

## Spacing & Visual Polish

- Normalize card padding/margins using Wander spacing scale
- Fix headline hierarchy (sizes, weights, line-height)
- Ensure contrast ratios meet WCAG AA standard
- Tighten borders, shadows, and transitions for cohesion

## Acceptance Criteria

- [ ] Dark and light themes toggle-able in header
- [ ] All pages render correctly in both themes
- [ ] localStorage persists user theme choice
- [ ] Auth page uses Wander Button component
- [ ] Dashboard stat cards use vibrant, readable accents
- [ ] No visual regression in existing functionality
- [ ] Spacing is consistent across cards, buttons, inputs

## Out of Scope

- Refactoring page layouts or domain logic
- Rewriting all custom CSS (incremental)
- Adding new features or pages
