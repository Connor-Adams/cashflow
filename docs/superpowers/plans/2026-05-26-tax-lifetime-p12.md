# Tax Lifetime / Retirement (Phase P12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.
>
> **Safe-push:** push ALL commits BEFORE opening PR.

**Goal:** MVP retirement-income modelling. Add personal override keys for pension/RRIF, CPP retirement, OAS retirement. Provide RRIF minimum-withdrawal calculator as reference. Engine already has OAS clawback + pension-income credit + age amount + age-at-year-end — P12 just plumbs retirement income through it.

**Architecture:** Pure additive. New override keys on personal scenarios:
- `income.pensionIncome` → writes `facts.pensionIncome` (existing field; routes through pension-income credit + L11500)
- `income.cppRetirement` → pushes to `facts.employmentIncome[]` (taxable, no pension credit)
- `income.oasRetirement` → pushes to `facts.employmentIncome[]` (taxable, OAS clawback automatic via existing L23500 calc)

Also: new `backend/src/tax/engine/rrif.ts` with the CRA prescribed RRIF minimum-withdrawal table (% by age). Reference-only — user uses it to size `income.pensionIncome` for projected RRIF years.

**Spec:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) section 4 (P12 row).

**Builds on (in main):** P9 multi-year projection (projection_root scenarios), existing T1 engine OAS clawback + pension-income credit + age amount.

**Out of scope (defer to P12b):**
- RRSP balance tracking (no model field; v1 assumes user knows the balance + computes RRIF withdrawal externally)
- Auto-projection of CPP/OAS based on age (v1 requires manual override per year)
- Estate / death scenarios + deemed disposition + spousal rollover
- CPP-retirement enhancement (start age 60-70 multiplier; benefit amount lookup)
- Indexed government benefit lookup (CRA publishes annual CPP/OAS max; v1 user types raw amounts)

**Conventions:** node:test, beforeEach sync, `--import ./backend/test/setup.ts`, conventional commits, `--message=` form, NEVER `Co-Authored-By`. `HUSKY=0 git commit ...` if pre-commit fails.

---

## Task plan

### T1 — RRIF minimum-withdrawal calc helper

**Files:**
- Create: `backend/src/tax/engine/rrif.ts` — exports `rrifMinPercent(age: number): number` returning the CRA prescribed %; ages <71 = 0; 71 = 0.0528; 72 = 0.0540; ... ; 95+ = 0.20 (per CRA Schedule 7300/2)
- Create: `backend/test/tax/rrif.test.ts` — spot-check 5 ages (70, 71, 80, 94, 95)

Full CRA table:
```
71: 0.0528, 72: 0.0540, 73: 0.0553, 74: 0.0567, 75: 0.0582,
76: 0.0598, 77: 0.0617, 78: 0.0636, 79: 0.0658, 80: 0.0682,
81: 0.0708, 82: 0.0738, 83: 0.0771, 84: 0.0808, 85: 0.0851,
86: 0.0899, 87: 0.0955, 88: 0.1021, 89: 0.1099, 90: 0.1192,
91: 0.1306, 92: 0.1449, 93: 0.1634, 94: 0.1879, 95+: 0.20
```

Also export `rrifMinWithdrawal(age: number, balance: number): number` = `balance × rrifMinPercent(age)`.

Tests: age 70 → 0; age 71 → 0.0528; age 80 → 0.0682; age 94 → 0.1879; age 100 → 0.20.

Commit: `feat(tax-engine): RRIF minimum-withdrawal table`

---

### T2 — Override keys for retirement income

**Files:**
- Modify: `backend/src/tax/scenarios/overrideKeys.ts` — add 3 personal-kind entries to registry:
  - `income.pensionIncome` → adds `value` to `facts.pensionIncome` (sets if undefined, else adds). Pushes IncomeItem to employment line tagged for clarity.
  - `income.cppRetirement` → pushes `IncomeItem{source:'override:income.cppRetirement', amount:value, cadAmount:value}` to `facts.employmentIncome[]`
  - `income.oasRetirement` → same shape, source `'override:income.oasRetirement'` pushed to `facts.employmentIncome[]`

For `income.pensionIncome` — engine reads `facts.pensionIncome` for pension-income credit calc but also needs the amount in the income totals. Two options: (a) double-stamp — set facts.pensionIncome AND push IncomeItem so income totals include it; (b) update engine to add facts.pensionIncome into income totals. Option (a) cleaner — no engine change.

```ts
{
  kind: 'personal',
  key: 'income.pensionIncome',
  label: 'Pension income (RRIF, employer pension, etc.) — CAD',
  inputType: 'decimal',
  validate: (v) => assertNumber(v, 'income.pensionIncome'),
  apply: (facts, value) => {
    assertNumber(value, 'income.pensionIncome');
    const d = D(String(value));
    return {
      ...facts,
      pensionIncome: (facts.pensionIncome ?? D('0')).plus(d),
      employmentIncome: [
        ...facts.employmentIncome,
        { source: 'override:income.pensionIncome', amount: d, cadAmount: d },
      ],
    };
  },
},
```

Modify: `backend/test/tax/scenarios/overrideKeys.test.ts` — add 3 tests, one per key, asserting:
- pensionIncome: stamps both facts.pensionIncome AND adds to employmentIncome[]
- cppRetirement: appends to employmentIncome[] only
- oasRetirement: appends to employmentIncome[] only

Commit: `feat(tax-scenarios): retirement income override keys (pension, CPP, OAS)`

---

### T3 — Frontend OverrideEditor KEY_DEFS additions + RRIF helper UI

**Files:**
- Modify: `frontend/src/pages/tax/scenarios/OverrideEditor.tsx` — add 3 entries to `KEY_DEFS`:
  ```ts
  { key: 'income.pensionIncome', label: 'Pension income (RRIF / employer) — CAD', inputType: 'decimal' },
  { key: 'income.cppRetirement', label: 'CPP retirement benefit — CAD', inputType: 'decimal' },
  { key: 'income.oasRetirement', label: 'OAS retirement benefit — CAD', inputType: 'decimal' },
  ```
- Create: `frontend/src/pages/tax/scenarios/RrifMinCalc.tsx` — small inline helper: 2 inputs (age, RRIF balance) → displays `rrifMinPercent(age)` and `min withdrawal = balance × pct`. Mirror the RRIF table from T1 as a frontend const (or fetch via small `/api/tax/rrif/min-percent?age=N` route — pick the simpler one). v1: mirror locally; small const table.
- Modify: `frontend/src/pages/tax/PersonalT1Tab.tsx` — show `RrifMinCalc` as a collapsible section when the active scenario is `kind === 'projection_root'` (only useful for retirement projection years)

Lint: `yarn workspace frontend run lint`.

Commit: `feat(tax): retirement income override keys + RRIF min calc UI`

---

### T4 — E2E retirement projection test

**Files:**
- Create: `backend/test/tax/scenarios/retirementE2E.test.ts`

Single test:
1. Seed personal entity w/ DOB making them age 72 in 2026 (per existing buildPersonalFacts DOB handling)
2. Create scenario for year 2026 (any kind; can be baseline w/ no actuals since user types overrides)
3. Override `income.pensionIncome = 50000`, `income.cppRetirement = 16000`, `income.oasRetirement = 8500` (rough OAS max-ish)
4. Compute scenario
5. Assert:
   - Total income ≈ $74,500 (sum of three benefits + any existing employment)
   - L23500 OAS clawback applied IF net income > clawback threshold ($90,997 in 2024 rate table)
   - Pension income credit applied (L31400 federal $2,000 cap)
   - Age amount applied (since age ≥ 65)

Run: `npx tsx --import ./backend/test/setup.ts --test backend/test/tax/scenarios/retirementE2E.test.ts`

Husky-in-worktree: `HUSKY=0 git commit ...`.

Commit: `test(tax): E2E retirement income projection`

---

## Pre-PR safe-push checklist

- [ ] All 4 task commits in branch (+ 1 plan)
- [ ] `yarn workspace cashflow-backend run typecheck` passes
- [ ] `yarn workspace cashflow-backend run test` passes (tax scenarios suite at minimum)
- [ ] `yarn workspace frontend run lint` passes
- [ ] **`git push` all commits BEFORE creating PR**
- [ ] Open PR + `--auto --merge`

## Risks / out of scope

- **No RRSP balance tracking** — user must compute RRIF min withdrawal manually using the helper (T1 supplies `rrifMinWithdrawal(age, balance)` as a calculator). Real retirement planning needs running balance + growth. P12b.
- **No CPP start-age adjustment** — CPP benefit varies by age claimed (60 → 70). v1: user types final amount. P12b: add `cppStartAge` + benefit-multiplier table.
- **No automatic income from prior year's projection** — P9 multi-year projects income forward via inflation, but doesn't add retirement-specific income (CPP starts at 65, OAS at 65, RRIF mandatory at 71). v1: user manually sets per year.
- **Pension splitting (P10) already supports retirement age** — pension-split + retirement income compose naturally (split RRIF income with spouse to reduce both clawback + bracket).
- **No estate / death scenario** — final return mechanics, deemed disposition of capital property, RRSP rollover. Genuinely complex. Defer indefinitely (most users will use accountant for death year).
