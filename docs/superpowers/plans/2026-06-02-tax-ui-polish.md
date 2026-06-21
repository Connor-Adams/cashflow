# Tax UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every dev-grade tab under `/tax` to the standard `OverviewTab`/`Hygiene`/`Reserve` already set — formatted money, kit components, headline stat cards — with zero behavior change.

**Architecture:** Pure frontend restyle. One new shared helper (`util/labels.ts`) created first; then each tab/cluster is transformed against a fixed contract (§ Canonical Patterns) so parallel workers stay consistent. No backend, route, or primitive changes.

**Tech Stack:** React + TypeScript, Tailwind v4, existing UI kit (`frontend/src/components/ui/*`), Vitest + Testing Library, yarn 1.22.

**Spec:** `docs/superpowers/specs/2026-06-02-tax-ui-polish-design.md`

---

## Canonical Patterns (reference — every tab task uses these)

These are the fixed idioms. Tasks below say "apply Pattern N" instead of repeating them.

### Pattern 1 — Money / percent formatting
```tsx
import { fmtCurrency, fmtPct } from './util/format'        // path adjusts per dir depth
// from frontend/src/pages/tax/scenarios/*  use '../util/format'

// BEFORE: {String(v)}            {`$${line.amount}`}      parseFloat(x).toFixed(2)
// AFTER:  {fmtCurrency(v)}       {fmtCurrency(line.amount)} {fmtCurrency(x)}
```
`fmtCurrency` accepts `string | number | null | undefined`, returns `$X,XXX.XX` (en-CA) or `—`. NEVER reintroduce a local `fmt`/`formatCell`/`formatPct`.

### Pattern 2 — Headline StatCard grid
```tsx
import { StatCard } from '@/components/ui/stat-card'

<div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
  <StatCard label="Total payable" value={fmtCurrency(totals.totalPayable)} />
  <StatCard
    label="Refund / owing"
    value={fmtCurrency(totals.refundOrOwing)}
    metricKind="gain"            // refund(+) tones positive, owing(−) tones warm
    delta={Number(totals.refundOrOwing) >= 0 ? '+refund' : '-owing'}
  />
  <StatCard label="Total income" value={fmtCurrency(totals.totalIncome)} />
  <StatCard label="Taxable income" value={fmtCurrency(totals.taxableIncome)} />
</div>
```
`StatCard` props: `{ label, value, hint?, delta?, metricKind? }`. Use 1–4 cards.

### Pattern 3 — Bare table → kit Table
```tsx
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Line</TableHead>
      <TableHead>Label</TableHead>
      <TableHead className="text-right">Amount</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {rows.map((r) => (
      <TableRow key={r.code}>
        <TableCell>{r.code}</TableCell>
        <TableCell>{r.label}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtCurrency(r.amount)}</TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```
Money columns always `className="text-right tabular-nums"` on both `TableHead` and `TableCell`.

### Pattern 4 — Reference detail → CollapsibleCard
```tsx
import { CollapsibleCard } from '@/components/ui/collapsible-card'

<CollapsibleCard title="Return detail (T1 lines)" defaultOpen={false}>
  {/* kit Table from Pattern 3 */}
</CollapsibleCard>
```
Props: `{ title, description?, actions?, defaultOpen?, children }`.

### Pattern 5 — Warnings → Alert
```tsx
import { Alert } from '@/components/ui/alert'   // verify export name on read; see step 0c
// Render the warning list inside a warn-tone Alert instead of a bare <ul>.
```

### Pattern 6 — Empty / dev text → EmptyState
```tsx
import { EmptyState } from '@/components/ui/empty-state'  // verify export
// "No personal entity… (POST /api/tax/entities)" becomes human guidance copy.
```

### Pattern 7 — Inline style → Tailwind (+ variant lookup)
```tsx
// BEFORE: style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}
// AFTER:  className="mt-4 flex gap-3"

// Variant classes via a literal-keyed lookup (Tailwind JIT needs literal strings):
const TONE_CLASS = { positive: 'text-emerald-600', warm: 'text-amber-600' } as const
<span className={TONE_CLASS[tone]}>…</span>
// NEVER: className={`text-${color}-600`}
```

### Humanized total labels
Use `labelForTotal(key)` from `./util/labels` (Task 1) to render `computed.totals` key dumps with human labels + `fmtCurrency` values.

---

## Task 0: Worktree setup

**Files:** none (environment).

- [ ] **Step 0a: Install deps** (worktrees have no `node_modules`)

Run: `cd <worktree-root> && yarn install`
Expected: completes; `node_modules/.bin/vitest` and `lint-staged` now exist (commits stop failing with exit 127).

- [ ] **Step 0b: Baseline green**

Run: `cd frontend && yarn vitest run src/pages/tax`
Expected: existing tax tests pass (`ClassifyTab.test.tsx` and any kit tests). Record the pass count.

- [ ] **Step 0c: Confirm kit export names**

Run: `rg -n "export" frontend/src/components/ui/alert.tsx frontend/src/components/ui/empty-state.tsx frontend/src/components/ui/badge.tsx`
Expected: note the exact exported component + prop names for Patterns 5/6 (e.g. `Alert` variant/tone prop). Use the real names in all tasks.

---

## Task 1: Shared label helper (`util/labels.ts`)

**Files:**
- Create: `frontend/src/pages/tax/util/labels.ts`
- Test: `frontend/src/pages/tax/util/labels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/pages/tax/util/labels.test.ts
import { describe, it, expect } from 'vitest'
import { TOTALS_LABELS, humanizeKey, labelForTotal } from './labels'

describe('tax total labels', () => {
  it('maps known total keys to human labels', () => {
    expect(labelForTotal('totalPayable')).toBe('Total payable')
    expect(labelForTotal('refundOrOwing')).toBe('Refund / owing')
    expect(labelForTotal('netTaxPayable')).toBe('Net tax payable')
    expect(TOTALS_LABELS.eiPremium).toBe('EI premiums')
  })

  it('humanizes unknown camelCase keys as a fallback', () => {
    expect(labelForTotal('smallBusinessDeduction')).toBe('Small business deduction')
    expect(humanizeKey('grossTaxBeforeCredits')).toBe('Gross tax before credits')
  })

  it('handles single-word and acronym-ish keys', () => {
    expect(humanizeKey('income')).toBe('Income')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/tax/util/labels.test.ts`
Expected: FAIL — cannot resolve `./labels`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/pages/tax/util/labels.ts
//
// Human labels for tax `computed.totals` keys. Known keys get curated labels;
// anything unmapped falls back to a camelCase→sentence-case humanizer so new
// corp/personal total keys still render readably without a code change.

export const TOTALS_LABELS: Record<string, string> = {
  totalIncome: 'Total income',
  netIncome: 'Net income',
  taxableIncome: 'Taxable income',
  federalTax: 'Federal tax',
  provincialTax: 'Provincial tax',
  cppContrib: 'CPP contributions',
  eiPremium: 'EI premiums',
  totalPayable: 'Total payable',
  refundOrOwing: 'Refund / owing',
  netTaxPayable: 'Net tax payable',
}

// camelCase → "Sentence case". 'grossTaxBeforeCredits' -> 'Gross tax before credits'.
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function labelForTotal(key: string): string {
  return TOTALS_LABELS[key] ?? humanizeKey(key)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && yarn vitest run src/pages/tax/util/labels.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/tax/util/labels.ts frontend/src/pages/tax/util/labels.test.ts
git commit -m "feat(tax): add humanized total-label helper for tax UI"
```

---

## Task 2: PersonalT1Tab (template tab — do this second, it sets the visual standard)

**Files:**
- Modify: `frontend/src/pages/tax/PersonalT1Tab.tsx`
- Test: `frontend/src/pages/tax/PersonalT1Tab.test.tsx` (create)

The transformation targets `ActiveScenarioPanel`, `LineBreakdownTable`, `LineRow`, and `CompareBar` (lines ~262–443 in the current file). Header/workspace logic (lines 1–260) is unchanged except removing inline `style` on the headers (Pattern 7).

- [ ] **Step 1: Write the failing formatting regression test**

```tsx
// frontend/src/pages/tax/PersonalT1Tab.test.tsx
import { describe, it, expect } from 'vitest'
import { fmtCurrency } from './util/format'
import { labelForTotal } from './util/labels'

// Locks the float-garbage fix: raw backend Decimal strings must render as
// grouped 2dp currency, and total keys must render humanized — never the raw
// key or the raw float.
describe('PersonalT1 totals formatting', () => {
  it('formats a raw Decimal string as en-CA currency', () => {
    expect(fmtCurrency('28796.51844732000000725')).toBe('$28,796.52')
    expect(fmtCurrency('-1444.756851500739998546375')).toBe('-$1,444.76')
  })

  it('humanizes total keys', () => {
    expect(labelForTotal('totalPayable')).toBe('Total payable')
    expect(labelForTotal('refundOrOwing')).toBe('Refund / owing')
  })
})
```

- [ ] **Step 2: Run test to verify the formatting contract**

Run: `cd frontend && yarn vitest run src/pages/tax/PersonalT1Tab.test.tsx`
Expected: PASS if `fmtCurrency` already groups (it does). If `-$1,444.76` differs (e.g. `$-1,444.76`), adjust the expected string to match `fmtCurrency`'s actual output — do NOT change `fmtCurrency`. This test documents real behavior and guards regressions.

- [ ] **Step 3: Rewrite the render sections**

In `PersonalT1Tab.tsx`:

a) Imports — add:
```tsx
import { fmtCurrency } from './util/format'
import { labelForTotal } from './util/labels'
import { StatCard } from '@/components/ui/stat-card'
import { Card } from '@/components/ui/card'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Alert } from '@/components/ui/alert'   // use real export from step 0c
```

b) `ActiveScenarioPanel` — replace the "Computed totals" `<section>`/`<ul>` (lines ~313–326) and the headline with:
```tsx
{/* Headline */}
<div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
  <StatCard label="Total payable" value={fmtCurrency(computed.totals.totalPayable)} />
  <StatCard label="Refund / owing" value={fmtCurrency(computed.totals.refundOrOwing)} />
  <StatCard label="Total income" value={fmtCurrency(computed.totals.totalIncome)} />
  <StatCard label="Taxable income" value={fmtCurrency(computed.totals.taxableIncome)} />
</div>

{/* All totals, humanized */}
<Card className="mb-4">
  <h4 className="mb-2 text-sm font-semibold">Computed totals</h4>
  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
    {Object.entries(computed.totals).map(([k, v]) => (
      <div key={k} className="flex justify-between">
        <dt className="text-muted-foreground">{labelForTotal(k)}</dt>
        <dd className="tabular-nums">{fmtCurrency(v as string)}</dd>
      </div>
    ))}
  </dl>
  <p className="muted mt-2 text-xs">
    {computed.cached ? 'Cached snapshot' : 'Freshly computed'} at{' '}
    {new Date(computed.computedAt).toLocaleString()}
  </p>
</Card>
```

c) Warnings `<section>` (lines ~327–336) → `Alert` (Pattern 5) rendering the same `computed.warnings` list.

d) Line breakdown `<section>` (lines ~337–340) → wrap in `CollapsibleCard`:
```tsx
<CollapsibleCard title="Return detail (T1 lines)" defaultOpen={false}>
  <LineBreakdownTable lines={lines} />
</CollapsibleCard>
```

e) `LineBreakdownTable` + `LineRow` (lines ~345–403) — convert the bare `<table>` to the kit `Table` (Pattern 3). Amount column right-aligned `fmtCurrency(line.amount)`. Keep the expand-on-click formula/inputs row; format each `i.amount` via `fmtCurrency`. Empty state via the `muted` paragraph is fine, or `EmptyState`.

f) `CompareBar` (lines ~412–443) — replace the inline `style={{ border, borderRadius, padding, marginTop }}` with `className="mt-4 rounded-md border border-border p-2"` (Pattern 7). Buttons keep behavior.

g) Header inline styles on `ActiveScenarioPanel` (line ~285) and the workspace `<header>` (lines 195, 285) → Tailwind classes.

- [ ] **Step 4: Verify formatting test + existing suite still green**

Run: `cd frontend && yarn vitest run src/pages/tax/PersonalT1Tab.test.tsx && yarn tsc -p tsconfig.json --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 5: Visual check**

Use the `/run` skill (or `yarn dev`), open `/tax` → Personal T1. Confirm: headline cards show formatted dollars; no `28796.518…` anywhere; "Return detail" collapses; warnings in an alert box. Screenshot.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/tax/PersonalT1Tab.tsx frontend/src/pages/tax/PersonalT1Tab.test.tsx
git commit -m "feat(tax): restyle Personal T1 with stat-card headline + formatted totals"
```

---

## Task 3: CorpT2Tab cluster

**Files:**
- Modify: `frontend/src/pages/tax/CorpT2Tab.tsx`
- Modify: `frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx`

- [ ] **Step 1: CorpT2Tab** — read the file. Apply, mirroring Task 2:
  - Headline grid (Pattern 2): Net tax payable + Taxable income + 2 most relevant corp totals (use the real keys present in `computed.totals`; `labelForTotal` for labels).
  - Replace the `String(v)` totals dump with the humanized `<dl>` block (Task 2b) using `labelForTotal` + `fmtCurrency`.
  - L-code breakdown bare `<table>` → kit `Table` (Pattern 3), money right-aligned, wrapped in `CollapsibleCard "Return detail (T2 lines)" defaultOpen={false}` (Pattern 4).
  - Warnings → `Alert` (Pattern 5).
  - Remove all ~20 inline styles → Tailwind (Pattern 7).
- [ ] **Step 2: CorpOverrideEditor** — read the file. Remove ~8 inline styles → Tailwind (Pattern 7). Format any displayed amounts via `fmtCurrency` (Pattern 1). Intercorp dividend distribution rows → kit `Table` if tabular.
- [ ] **Step 3: Verify**

Run: `cd frontend && yarn tsc -p tsconfig.json --noEmit && yarn vitest run src/pages/tax`
Expected: no type errors, tests green.

- [ ] **Step 4: Visual check** Corp T2 tab. Screenshot. No raw floats, no bare table.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/tax/CorpT2Tab.tsx frontend/src/pages/tax/scenarios/CorpOverrideEditor.tsx
git commit -m "feat(tax): restyle Corp T2 + corp override editor to kit components"
```

---

## Task 4: Scenario shared cluster

**Files:**
- Modify: `frontend/src/pages/tax/scenarios/ComparisonView.tsx`
- Modify: `frontend/src/pages/tax/scenarios/HouseholdRollupCard.tsx`
- Modify: `frontend/src/pages/tax/MultiYearCompareCard.tsx`
- Modify: `frontend/src/pages/tax/scenarios/ScenarioTree.tsx`
- Modify: `frontend/src/pages/tax/scenarios/OverrideEditor.tsx`

- [ ] **Step 1: ComparisonView** — delete local `formatCell()`; use `fmtCurrency`/`fmtPct` (Pattern 1). Multi-column totals table → kit `Table` (Pattern 3). Leave the corp-keys-blank logic as-is; add one comment: `// NOTE: corp scenarios still render blank — TOTAL_KEYS mismatch, pre-existing, out of scope (see spec).`
- [ ] **Step 2: HouseholdRollupCard** — delete local `formatCell`/`formatPct` → shared helpers. Headline numbers (total household tax, joint effective rate) → `StatCard`s (Pattern 2; rate uses `fmtPct`). Per-spouse table → kit `Table` (Pattern 3).
- [ ] **Step 3: MultiYearCompareCard** — delete local `fmt()` → `fmtCurrency`. YoY table → kit `Table`. Negatives (refund/owing) via `fmtCurrency` (drop the custom `(amount)` paren format).
- [ ] **Step 4: ScenarioTree** — remove ~2 inline styles → Tailwind (Pattern 7); style the `<ul>` list; keep fork/delete/select behavior.
- [ ] **Step 5: OverrideEditor** — bare `<table>` (override list + capital-gains disposition sub-table) → kit `Table` (Pattern 3). Format displayed amounts (Pattern 1). Remove ~3 inline styles.
- [ ] **Step 6: Verify**

Run: `cd frontend && yarn tsc -p tsconfig.json --noEmit && yarn vitest run src/pages/tax`
Expected: green.

- [ ] **Step 7: Visual check** — open compare (add ≥2 scenarios), multi-year card, household rollup. Screenshot.
- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/tax/scenarios/ComparisonView.tsx frontend/src/pages/tax/scenarios/HouseholdRollupCard.tsx frontend/src/pages/tax/MultiYearCompareCard.tsx frontend/src/pages/tax/scenarios/ScenarioTree.tsx frontend/src/pages/tax/scenarios/OverrideEditor.tsx
git commit -m "feat(tax): unify scenario views on shared formatter + kit Table"
```

---

## Task 5: Owner comp cluster

**Files:**
- Modify: `frontend/src/pages/tax/OwnerCompPlannerTab.tsx`
- Modify: `frontend/src/pages/tax/scenarios/OwnerCompLeverSurface.tsx`

- [ ] **Step 1: OwnerCompPlannerTab** — humanize the "POST /api/tax/entities" dev text → `EmptyState` guidance (Pattern 6). Bare `<h2>` → `PageHeader` or styled heading. Remove the 1 inline style.
- [ ] **Step 2: OwnerCompLeverSurface** — read the file (550 lines). Complete formatter coverage (it imports `fmtCurrency`/`fmtPct` partially — ensure every money/% value uses it, Pattern 1). Rollup numbers (personal payable, corp net tax, total tax, joint rate) → `StatCard`s (Pattern 2). Remove any inline styles. Sliders/behavior unchanged.
- [ ] **Step 3: Verify**

Run: `cd frontend && yarn tsc -p tsconfig.json --noEmit && yarn vitest run src/pages/tax`
Expected: green.

- [ ] **Step 4: Visual check** — Owner Comp tab, move a slider, confirm totals reformat live. Screenshot.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/tax/OwnerCompPlannerTab.tsx frontend/src/pages/tax/scenarios/OwnerCompLeverSurface.tsx
git commit -m "feat(tax): restyle owner-comp planner + lever surface"
```

---

## Task 6: Ledger-ish cluster

**Files:**
- Modify: `frontend/src/pages/tax/ShareholderLoanTab.tsx`
- Modify: `frontend/src/pages/tax/InstalmentTracker.tsx`
- Modify: `frontend/src/pages/tax/ReconciliationTab.tsx`

- [ ] **Step 1: ShareholderLoanTab** — headline `StatCard`: loan balance (the value the recent "show shareholder-loan balance" work computes; reuse that derived value). Format `$loan.amount` via `fmtCurrency` (Pattern 1). Loan entry bare `<table>` → kit `Table` (Pattern 3). Remove ~3 inline styles.
- [ ] **Step 2: InstalmentTracker** — `parseFloat(item.amount).toFixed(2)` → `fmtCurrency` (Pattern 1). Payment table → kit `Table`. Remove ~2 inline styles.
- [ ] **Step 3: ReconciliationTab** — headline `StatCard`s: warnings count + findings count. Per-category finding lists → `Card`s; tabular findings → kit `Table` (Pattern 3).
- [ ] **Step 4: Verify**

Run: `cd frontend && yarn tsc -p tsconfig.json --noEmit && yarn vitest run src/pages/tax`
Expected: green.

- [ ] **Step 5: Visual check** — Shareholder Loans, Reconciliation tabs; instalment tracker on Overview. Screenshot.
- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/tax/ShareholderLoanTab.tsx frontend/src/pages/tax/InstalmentTracker.tsx frontend/src/pages/tax/ReconciliationTab.tsx
git commit -m "feat(tax): restyle shareholder-loan, instalment, reconciliation tabs"
```

---

## Task 7: Slips / Classify cluster

**Files:**
- Modify: `frontend/src/pages/tax/SlipsTab.tsx`
- Modify: `frontend/src/pages/tax/slips/T3Form.tsx`, `T4Form.tsx`, `T4AForm.tsx`, `T5Form.tsx`, `T5008Form.tsx`
- Modify: `frontend/src/pages/tax/ClassifyTab.tsx`, `ClassifyRow.tsx`

- [ ] **Step 1: SlipsTab + forms** — format any displayed amounts via `fmtCurrency` (Pattern 1). Slip list → kit `Table` (Pattern 3) if tabular. Forms: light touch — kit `input`/`label`/`button` where bare, no inline styles. Behavior unchanged.
- [ ] **Step 2: ClassifyTab + ClassifyRow** — format the amount(s) (Pattern 1). Row/table styling via kit. Keep behavior — `ClassifyTab.test.tsx` MUST stay green.
- [ ] **Step 3: Verify**

Run: `cd frontend && yarn tsc -p tsconfig.json --noEmit && yarn vitest run src/pages/tax`
Expected: green incl. `ClassifyTab.test.tsx`.

- [ ] **Step 4: Visual check** — Slips, Classify tabs. Screenshot.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/tax/SlipsTab.tsx frontend/src/pages/tax/slips/ frontend/src/pages/tax/ClassifyTab.tsx frontend/src/pages/tax/ClassifyRow.tsx
git commit -m "feat(tax): restyle slips + classify tabs"
```

---

## Task 8: Cleanup cluster (already-formatted tabs + page shell)

**Files:**
- Modify: `frontend/src/pages/tax/TaxHygieneTab.tsx`
- Modify: `frontend/src/pages/tax/TaxReserveTab.tsx`
- Modify: `frontend/src/pages/tax/scenarios/YearStripNav.tsx`
- Modify: `frontend/src/pages/tax/scenarios/AssumptionsEditor.tsx`
- Modify: `frontend/src/pages/TaxPage.tsx`

- [ ] **Step 1: TaxHygieneTab / TaxReserveTab** — already use `fmtCurrency`. Convert residual inline styles (~23 / ~33) → Tailwind (Pattern 7). Ensure any tables are kit `Table`. No behavior change.
- [ ] **Step 2: YearStripNav / AssumptionsEditor** — verify formatter use where numeric; remove any inline styles. (Mostly Tailwind already.)
- [ ] **Step 3: TaxPage** — `<header style={{…}}>` → `PageHeader` (Pattern 7). Tabs/year jump unchanged.
- [ ] **Step 4: Verify**

Run: `cd frontend && yarn tsc -p tsconfig.json --noEmit && yarn vitest run src/pages/tax`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/tax/TaxHygieneTab.tsx frontend/src/pages/tax/TaxReserveTab.tsx frontend/src/pages/tax/scenarios/YearStripNav.tsx frontend/src/pages/tax/scenarios/AssumptionsEditor.tsx frontend/src/pages/TaxPage.tsx
git commit -m "feat(tax): tidy hygiene/reserve inline styles + page header"
```

---

## Task 9: Final integration + acceptance

**Files:** none (verification only).

- [ ] **Step 1: Acceptance greps** (must all return nothing under `frontend/src/pages/tax/`)

Run:
```bash
cd frontend/src/pages/tax
rg -n "String\((computed|v|total)" .            # raw total dumps
rg -n '\$\{[^}]*amount' .                        # money template interpolation
rg -n "parseFloat.*toFixed" .                    # manual money formatting
rg -n "function (fmt|formatCell|formatPct)\b" .  # local formatter re-impls
rg -n "style=\{\{" .                             # remaining inline styles
rg -n "<table\b|<thead\b|<tbody\b" .             # bare tables (kit uses <Table>)
```
Expected: all empty. (One allowed exception: the documented corp-keys-blank `// NOTE` comment in ComparisonView is text, not code — it won't match these.)

- [ ] **Step 2: Full suite + build + lint**

Run: `cd frontend && yarn vitest run && yarn tsc -p tsconfig.json --noEmit && yarn build && yarn lint`
Expected: all green.

- [ ] **Step 3: Full visual sweep** — `/run`, walk every tax tab. Confirm consistency: headline cards, formatted money, collapsibles, alerts. Capture before/after of Personal T1 + Corp T2.

- [ ] **Step 4: Open PR**

```bash
git push -u origin claude/eloquent-galileo-e2354d
gh pr create --title "feat(tax): polish the tax UI — formatted money, kit components, headline stat cards" \
  --body "Full-sweep restyle of /tax per docs/superpowers/specs/2026-06-02-tax-ui-polish-design.md. Zero behavior change. Kills raw Decimal float strings, replaces bare tables/inline styles with the UI kit, adds headline stat cards. Pre-existing ComparisonView corp-keys-blank bug left as-is (noted in code)."
```
Then enable auto-merge with a merge commit per repo convention:
```bash
gh pr merge --auto --merge
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §A contract → Canonical Patterns + per-task rules. §B per-tab → Tasks 2–8 (every listed file mapped). §C out-of-scope → ComparisonView NOTE (Task 4) + no backend tasks. §D verification → Tasks 1/2 tests + Task 9 acceptance. §labels helper → Task 1.
- **Placeholder scan:** new code (labels.ts, tests, PersonalT1 render) is complete. Restyle tabs reference fixed Patterns + concrete per-file specifics — no "add error handling"-style hand-waving.
- **Type consistency:** `labelForTotal`/`humanizeKey`/`TOTALS_LABELS` defined in Task 1, used identically after. `fmtCurrency`/`fmtPct` are existing exports. StatCard/Card/CollapsibleCard/Table props match the kit as read.
- **Known soft spots (intentional):** kit `Alert`/`EmptyState` export + prop names confirmed at Task 0c before use; corp `computed.totals` keys resolved by reading the file in Task 3 (humanizeKey covers any unmapped key).
