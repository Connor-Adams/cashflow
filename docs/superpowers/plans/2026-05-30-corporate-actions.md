# Corporate Actions Implementation Plan (issue #301)

> **For agentic workers:** Implement task-by-task with TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let users record corporate actions (dividend in kind, spin-off, merger, return of capital) so adjusted cost base (ACB) stays correct.

**Architecture:** Add three nullable columns to `investment_activities`; extend the pure single-security `computeAcb` engine for the new types; add `POST /api/portfolio/activities` that validates per type and, for cross-security actions, writes a basis-injection `transfer_in` onto the recipient security's stream in one transaction; add a corporate-action form to `PortfolioSecurityPage`.

**Tech Stack:** TypeScript, Sequelize, Express, node:test (backend unit/migration), supertest + Postgres (backend integration), React + vitest + testing-library (frontend).

---

## File Structure

- `backend/src/migrations/20260530000001-corporate-actions.js` — new migration (3 columns).
- `backend/test/migrations/corporateActionsMigration.test.ts` — round-trip migration test.
- `backend/src/models/InvestmentActivity.ts` — add 3 nullable fields.
- `backend/src/portfolio/acb.ts` — extend `AcbActivity` + add `dividend_in_kind`, `spin_off`, `merger` branches.
- `backend/test/portfolio/acb.test.ts` — pure unit tests for new types + ROC assertions.
- `backend/src/portfolio/corporateActionValidation.ts` — pure per-type validation function (reused by route + tested directly).
- `backend/test/portfolio/corporateActionValidation.test.ts` — unit tests for validation.
- `backend/src/routes/portfolio.ts` — add `POST /activities` handler (maps activity rows to ACB input must also pass new fields at all 3 call sites).
- `backend/test/integration/portfolioCreateActivity.test.ts` — endpoint integration test.
- `backend/test/integration/portfolioFixtures.ts` — extend `seedActivity` to accept the new fields (optional).
- `frontend/src/pages/PortfolioSecurityPage.tsx` — add corporate-action form.
- `frontend/src/pages/PortfolioSecurityPage.test.tsx` — form behavior tests.
- `frontend/src/types/api.ts` — extend `InvestmentActivity` type with new optional fields if surfaced.

---

## Task 1: Migration + round-trip test

**Files:** Create `backend/src/migrations/20260530000001-corporate-actions.js`, `backend/test/migrations/corporateActionsMigration.test.ts`.

- [ ] **Step 1: Write the failing migration test** (mirror `savedSearchesMigration.test.ts`): create a minimal `investment_activities` + `securities` table, require the migration, assert `up` adds `recipient_security_id`, `cost_basis_allocation_pct`, `cash_component` (all nullable), and `down` removes exactly those three.
- [ ] **Step 2: Run** `yarn workspace cashflow-backend run test` filtered to the file — expect FAIL (cannot find module / columns absent).
- [ ] **Step 3: Write the migration** using `queryInterface.addColumn` for the three columns (DECIMAL(5,4), DECIMAL(18,4), INTEGER nullable); `down` removes them. Follow `20260525000001-add-split-ratio.js`.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit.**

## Task 2: Model fields

**Files:** Modify `backend/src/models/InvestmentActivity.ts`.

- [ ] **Step 1:** Add `declare recipientSecurityId: number | null; declare costBasisAllocationPct: string | null; declare cashComponent: string | null;` and the matching `init` attributes (`recipient_security_id` INTEGER nullable; `cost_basis_allocation_pct` DECIMAL(5,4) nullable; `cash_component` DECIMAL(18,4) nullable).
- [ ] **Step 2: Run** `yarn workspace cashflow-backend run typecheck` — expect PASS.
- [ ] **Step 3: Commit.**

## Task 3: ACB engine — dividend_in_kind, spin_off, merger

**Files:** Modify `backend/src/portfolio/acb.ts`; tests in `backend/test/portfolio/acb.test.ts`.

ACB rules (hand-computed expected values are the source of truth):
- `dividend_in_kind`: requires quantity; `totalCost` unchanged, `quantity += q`, `acbPerUnit = totalCost / newQty`. No realized event.
- `spin_off`: requires `costBasisAllocationPct` in (0,1]; `totalCost *= (1 - pct)`; quantity unchanged; `acbPerUnit` recomputed. No realized event. (Recipient basis handled by the route, not the engine.)
- `merger`: source disposal. `cashProceeds = (cashComponent ?? 0) * quantitySold` where quantitySold = current position; realized event `proceeds = cashProceeds`, `costRemoved = totalCost`, `realizedGain = cashProceeds - totalCost`; then position zeroed.

- [ ] **Step 1:** Add failing unit tests:
  - dividend_in_kind: buy 10@$1000 (acb 100), dividend_in_kind +2 shares → qty 12, totalCost 1000, acb 1000/12 ≈ 83.3333.
  - spin_off: buy 10@$1000 (acb 100), spin_off pct 0.25 → totalCost 750, qty 10, acb 75. Recipient gets 250 (asserted via the route test, not here).
  - merger: buy 10@$1000 (acb 100), merger cashComponent $5/sh → proceeds 50, costRemoved 1000, realizedGain -950, position zeroed (qty 0, totalCost 0). And merger with no cash → proceeds 0, realizedGain -1000.
  - spin_off invalid pct (0 or >1) → ignored with a warning, state unchanged.
- [ ] **Step 2: Run** the acb test file — expect FAIL.
- [ ] **Step 3:** Add `costBasisAllocationPct`, `cashComponent`, `recipientSecurityId` to `AcbActivity`; add the three branches in `computeAcb` mirroring existing branch style (EPS guards, warnings).
- [ ] **Step 4: Run** the acb test file — expect PASS (incl. all pre-existing tests).
- [ ] **Step 5:** Add ROC assertion tests (already-implemented behavior): ROC $200 against totalCost $1000 → totalCost 800; ROC $1200 against $1000 → totalCost 0 + a realized deemed-gain event of $200. Run — expect PASS.
- [ ] **Step 6: Commit.**

## Task 4: Per-type validation helper

**Files:** Create `backend/src/portfolio/corporateActionValidation.ts`, `backend/test/portfolio/corporateActionValidation.test.ts`.

Signature: `validateCorporateAction(input): { ok: true } | { ok: false; code: string; message: string }`. Rules per design "API surface". Codes: `DIVIDEND_IN_KIND_REQUIRES_SHARES`, `SPINOFF_REQUIRES_RECIPIENT`, `SPINOFF_REQUIRES_SHARES`, `SPINOFF_ALLOCATION_OUT_OF_RANGE`, `MERGER_REQUIRES_RECIPIENT`, `MERGER_REQUIRES_SHARES`, `ROC_REQUIRES_AMOUNT`. Existing types (buy/sell/split/drip/reinvestment) and any other → `{ ok: true }` (the endpoint focuses on corporate actions; buy/sell still come from import).

- [ ] **Step 1:** Write failing unit tests covering each pass + each rejection code.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Implement the pure function.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit.**

## Task 5: POST /api/portfolio/activities endpoint

**Files:** Modify `backend/src/routes/portfolio.ts`; ALSO update the 3 `acbInput` maps (lines ~746, ~910, ~1523) to pass `costBasisAllocationPct: n(...)`, `cashComponent: n(...)`, `recipientSecurityId: r.recipientSecurityId`. Test `backend/test/integration/portfolioCreateActivity.test.ts`.

Handler behavior:
- Auth + scope: account must be in `visibleAccountWhere(req)` and `accountType==='investment'`; else 404/400. securityId must be a household security.
- Validate via `validateCorporateAction`; on fail → `400 { error, code }`.
- Create the primary `InvestmentActivity` (synthesize `sourceRowFingerprint = 'manual:' + crypto.randomUUID()`, `importBatch='manual'`, `description` defaulted to a human label) with new fields.
- For `spin_off`: also create a recipient `transfer_in` activity on `recipientSecurityId` with `amount = pct * parentTotalBasis` and `quantity = recipientShares`. Compute parent basis by running `computeAcb` over the parent's existing activities up to/incl. this one. Wrap both creates in one `sequelize.transaction`.
- For `merger`: create recipient `transfer_in` with `amount = max(parentBasis - cashProceeds, 0)`, `quantity = recipientShares`; same transaction.
- Respond `201 { activity, recipientActivity? }`.

- [ ] **Step 1:** Write failing integration tests (mirror `portfolioSecurityDrill.test.ts` setup): (a) dividend_in_kind POST → 201, then GET drill shows new per-unit ACB; (b) spin_off POST → 201 + recipient activity created with allocated basis, GET recipient drill shows that cost; (c) merger POST → 201 + source disposed (realizedTotal reflects cash-as-proceeds) + recipient basis = parentBasis - cash; (d) return_of_capital POST → 201; ROC > basis surfaces deemed gain in drill realizedTotal; (e) validation rejections return the documented 400 codes; (f) cross-household security rejected.
- [ ] **Step 2: Run** `yarn workspace cashflow-backend run test:integration` filtered — expect FAIL (404 route).
- [ ] **Step 3:** Implement the handler + update the 3 acbInput maps. Register `router.post('/activities', ...)`.
- [ ] **Step 4: Run** integration test — expect PASS.
- [ ] **Step 5:** Run full `test` + `test:integration` to confirm no regressions.
- [ ] **Step 6: Commit.**

## Task 6: Frontend corporate-action form

**Files:** Modify `frontend/src/pages/PortfolioSecurityPage.tsx`, `frontend/src/types/api.ts` (optional new fields); test `frontend/src/pages/PortfolioSecurityPage.test.tsx`.

Form (collapsible "Add corporate action" above the activities table):
- Type `<select>` with 8 options + labels (issue copy). Buy/Sell/Split/DRIP show minimal fields (date, quantity, amount); the 4 new types show their specific fields + help text.
- Conditional fields per type; recipient-security `<select>` (the household's securities, fetched from existing portfolio data or a securities list) for spin_off/merger.
- Inline validation mirrors API: allocation 0–1 (`Allocation must be between 0 and 1.`), recipient required (`Pick the new security.`), shares/amount > 0; block submit + show inline error.
- On submit: `postJson('/api/portfolio/activities', body)`; on success invalidate the security-detail query (`queryClient.invalidateQueries`) so the cost-basis row refreshes (AC#9); toast success/error states.

- [ ] **Step 1:** Write failing component tests: (a) selecting "Spin-off" reveals recipient + allocation + shares fields and hides ROC amount; (b) allocation 1.5 shows the inline error and blocks submit; (c) selecting "Return of capital" shows only the amount field; (d) a successful dividend_in_kind submit calls postJson with the right body and invalidates the query; (e) existing activities still render (AC#10 — read-only table unchanged).
- [ ] **Step 2: Run** `yarn workspace frontend run test` filtered — expect FAIL.
- [ ] **Step 3:** Implement the form + wiring. Use a `CORPORATE_ACTION_FIELDS` lookup table keyed by type (Tailwind variant classes via literals).
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5:** `yarn workspace frontend run tsc -b` + lint — expect clean.
- [ ] **Step 6: Commit.**

## Task 7: Full verification

- [ ] Backend unit `test`, backend `test:integration`, backend `typecheck`, backend `lint`.
- [ ] Frontend `test`, `tsc -b`, `lint`.
- [ ] Migration up/down on real Postgres (or document if unavailable).
- [ ] Commit any fixups, push, open PR with the AC→test mapping and the documented deviations.
