# Badge Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. This is a `cashflow-ui-sweep` Mode-B (consolidate a pattern into a primitive) instance.

**Goal:** Fold the bespoke "count chip" badge classes (`transactionsPanelBadge` ×10, `txnBadge`, `txnBadge--review`) into a new `Badge` `count` variant, adopt it in all 3 consumer files (TransactionsPage, RulesPage, RulesHealthSection), and DELETE the now-fully-dead App.css badge classes. Kills the cross-page coupling (pages borrowing a `transactions*` class).

**Architecture:** Extend the existing CVA `Badge` (`frontend/src/components/ui/badge.tsx`) with a `count` variant matching the uppercase-bold-0.68rem chip. Since these 3 files are the ONLY consumers of `.transactionsPanelBadge`/`.txnBadge`/`.txnBadge--review`, after adoption those rules are dead and get removed from `App.css` in the same PR.

**Tech Stack:** React 19, Tailwind v4 (CVA + twMerge), vitest. Reference: `badge.tsx`, `button.tsx` (CVA house style).

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/consolidate-badge` (node_modules symlinked).
- Commit husky workaround: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Token-only color; no hex. Adoption is a deliberate standardization (the `count` variant uses token colors approximating the old color-mix tints) — note it.

## The `count` variant (the real App.css rules to fold)
- `.transactionsPanelBadge` (App.css:656): `rounded-md border px-2.5 py-1 text-[0.68rem] font-bold uppercase tracking-normal` + border `color-mix(border 86%, white 6%)` + bg `color-mix(bg3 62%, transparent)`.
- `.txnBadge` (App.css:1181): same chip, `color: var(--muted-foreground)`, no bg.
- `.txnBadge--review` (App.css:1188): + border `color-mix(accent-warm 46%)` + `color: var(--warning-foreground)` (a warning-toned count chip).

Design: ONE new variant `count` (neutral chip); the single `txnBadge--review` usage = `count` + a warning className override. Do NOT speculatively add warning/info/success variants (YAGNI — nothing else needs them).

```
count: 'border-border bg-muted px-2.5 py-1 text-[0.68rem] font-bold uppercase tracking-normal text-muted-foreground'
```
(twMerge: `count` overrides the base cva's `px-2 py-0.5 text-xs font-medium`; the base's no-color string lets count supply border/bg/text. `bg-muted` + `border-border` are the token approximation of the color-mix tints — a deliberate standardization.)

---

### Task 1: Add the `count` variant + test + gallery (TDD)

**Files:**
- Modify: `frontend/src/components/ui/badge.tsx`
- Create: `frontend/src/components/ui/badge.test.tsx`
- Modify: `frontend/src/pages/settings/sections/DesignSystemSection.tsx` (the existing Badges group → add the count variant)

- [ ] **Step 1: Failing test** — `frontend/src/components/ui/badge.test.tsx`:
```tsx
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Badge } from './badge'

describe('Badge', () => {
  it('default variant renders the brand chip', () => {
    const { container } = render(<Badge>New</Badge>)
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement
    expect(el.className).toContain('bg-brand')
  })
  it('count variant is an uppercase bold compact chip', () => {
    const { container } = render(<Badge variant="count">5 rules</Badge>)
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement
    expect(el.className).toContain('uppercase')
    expect(el.className).toContain('font-bold')
    expect(el.className).toContain('text-[0.68rem]')
    expect(el.className).not.toContain('text-xs') // twMerge dropped the base size
  })
})
```

- [ ] **Step 2: Run red** — `yarn workspace frontend run test badge` → FAIL (count variant missing / file new).

- [ ] **Step 3: Implement** — add the `count` variant string (above) to `badgeVariants.variants.variant` in `badge.tsx`. Nothing else changes.

- [ ] **Step 4: Run green** — `yarn workspace frontend run test badge` → PASS. (If `text-[0.68rem]` doesn't override `text-xs`, confirm twMerge handles arbitrary font-size vs `text-xs` — it does; both are font-size utilities.)

- [ ] **Step 5: Gallery** — in `DesignSystemSection.tsx`'s existing `<Group name="Badges">`, add `<Badge variant="count">Count</Badge>` (and keep existing badge demos). Don't rename the group.

- [ ] **Step 6: Verify + commit** — `yarn workspace frontend run test badge DesignSystemSection` green; `yarn workspace frontend run lint` clean.
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "feat(ui): add Badge count variant (uppercase chip) + gallery"
```

---

### Task 2: Adopt + delete dead App.css

**Files:** Modify `frontend/src/pages/TransactionsPage.tsx`, `frontend/src/pages/RulesPage.tsx`, `frontend/src/components/RulesHealthSection.tsx`, `frontend/src/App.css`

- [ ] **Step 1: Adopt `<Badge variant="count">`** (commit `refactor(ui): adopt Badge count variant; drop bespoke badge classes`)

In the 3 files, replace each bespoke badge with the primitive (import `Badge` from `@/components/ui/badge` where not already imported):
- `<span className="transactionsPanelBadge">{…}</span>` (×10) → `<Badge variant="count">{…}</Badge>`.
- `<span className="txnBadge">{…}</span>` → `<Badge variant="count">{…}</Badge>`.
- `<… className="txnBadge txnBadge--review">{…}</…>` → `<Badge variant="count" className="border-warning text-warning-foreground">{…}</Badge>` (preserve the warning tone; confirm `border-warning`/`text-warning-foreground` are valid tokens — grep index.css; if not, use the closest existing warning token, e.g. `bg-warning-bg text-warning-foreground`).
Keep the badge CONTENT and any other attributes verbatim. Grep each file for the class to find every occurrence (there are 10 transactionsPanelBadge total across the 3 files).
Run the 3 consumer tests green: `yarn workspace frontend run test TransactionsPage RulesPage RulesHealthSection`.

- [ ] **Step 2: Delete the dead App.css rules** (same commit or a follow-up `refactor(css): remove dead txnBadge/transactionsPanelBadge rules`)

These 3 files were the ONLY consumers. Confirm zero references remain, then delete the rules from `App.css`: `.transactionsPanelBadge` (~656), `.txnBadge` (~1181), `.txnBadge--review` (~1188) — and any `.txnBadge`-prefixed sub-rules. Verify with:
```bash
cd frontend/src
grep -rn 'txnBadge\|transactionsPanelBadge' pages components   # expect 0
```
If anything still references them, do NOT delete (re-scope). 

- [ ] **Step 3: Verify** — `yarn workspace frontend run test TransactionsPage RulesPage RulesHealthSection` green; `yarn workspace frontend run lint` clean; broad `yarn workspace frontend run test --run` green.

---

## Self-Review
- **Coverage:** `count` variant added + tested + galleried (T1); all 3 consumers adopted + dead App.css removed (T2). ✓
- **Complete consolidation:** because the 3 files are the only consumers, the bespoke classes are fully removed (no lingering dead CSS) — the ideal end state per the skill. ✓
- **Coupling fixed:** RulesPage/RulesHealthSection no longer borrow the `transactions*` badge class. ✓
- **Standardization noted:** `count` uses `bg-muted`/`border-border` token approximations of the old color-mix tints — a deliberate, minor visual standardization. The warning review badge keeps its tone via a className.
- **Risk:** low — additive variant; adoption is span→Badge with near-equivalent styling; 3 consumer tests guard. YAGNI honored (no speculative semantic variants).
