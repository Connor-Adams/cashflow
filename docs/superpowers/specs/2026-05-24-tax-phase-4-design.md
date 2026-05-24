# Tax Phase 4 — Carryforwards Auto-Roll + Multi-Year — Design

**Date:** 2026-05-24
**Status:** Active
**Context:** Builds on Phase 1 (#118) + Phase 1 followups (#125). Phase 2 personal credits (#127) and Phase 3 corp engine (#129) land in parallel; this PR's first slice is independent of both since carryforward roll-forward operates on the generic Carryforward table.

---

## Goals

1. Auto-derive next-year `Carryforward` rows from current-year computed `TaxReturn` (personal) + `CorpTaxReturn` (corp, once Phase 3 lands).
2. Multi-year compare endpoint that lists annual summaries for an entity.
3. Instalment payment ledger so the engine can reduce `refundOrOwing` correctly across years.

## PR plan

### PR 1: Personal carryforward roll-forward + instalments
1. **Service** `backend/src/tax/services/rollPersonalCarryforwards.ts`:
   - Input: `entityId`, `year`, `TaxReturn`, `TaxYearFacts`
   - Computes next-year `Carryforward` rows:
     - `net_capital_loss` = previous balance + new realized losses (50% included) − amounts applied this year
     - `non_cap_loss` = previous balance − amounts applied this year + new non-cap loss (only if taxable income went negative this year)
     - `rrsp_room` = previous balance + (18% × earned income, capped at CRA annual limit) − contributions claimed this year
     - `fhsa_room` = previous balance + $8,000 carry-forward (capped at $40,000 lifetime) − contributions claimed
     - `instalments_paid` = (carried over for next year is $0; payments live in their own ledger)
   - Upsert with conflict on `(entity_id, kind, as_of_year)` (unique index already exists).
2. **Hook** in `/api/tax/personal/:year/return` route: after computing snapshot, optionally roll to year+1 if query `?roll=true`. Default off to avoid surprise mutations.
3. **Explicit roll route**: `POST /api/tax/personal/:year/roll-forward` → triggers roll service.
4. **Multi-year compare**: `GET /api/tax/personal/years?from=YYYY&to=YYYY` → returns `[{year, totals, computedAt}, ...]` from `TaxReturn` snapshots (no recompute).
5. **Instalment ledger**:
   - New table `instalment_payments`: `id, entity_id, year, quarter (1-4), amount, paid_on, notes`
   - Migration + model
   - Routes: `GET /api/tax/personal/:year/instalments`, `POST /api/tax/personal/:year/instalments`
   - Builder `buildPersonalFacts` sums payments for year and writes to `carryforwards.instalmentsPaid` (overrides any manually seeded value).
6. **Rate-table additions**: `rrspAnnualLimit` per year (2024: $31,560; 2025: $32,490; 2026: ~$33,367 indexed), `fhsaLifetimeLimit: $40000`, `fhsaAnnualLimit` already exists from Phase 2.

### PR 2: Corp carryforward roll-forward (after Phase 3 PR 1 merges)
- Service `rollCorpCarryforwards.ts` that reads `CorpTaxReturn.totals.{gripEnding, cdaEnding, erdtohEnding, nerdtohEnding}` and writes next-year balances.
- Same auto-roll hook on corp return route.

### PR 3: Multi-year UI
- Multi-year compare card in Tax Overview tab
- Instalment-tracker section per year

## Out of scope (Phase 4)
- Optimizer (Phase 5)
- T3-trust roll-forwards
- TFSA contribution room tracking (TFSA growth is tax-free; no carryforward needed)

## Risks
- RRSP room formula: 18% × prior-year earned income up to annual limit, minus PA (pension adjustment from T4 box 52). For Phase 4 PR 1 we ignore PA (defaults 0); flag for Phase 5 enhancement.
- Auto-roll could overwrite a manually-seeded carryforward row. Use upsert; warn if a manual row exists with the same `(entity_id, kind, as_of_year)` triple.
- Instalment payments tracked at quarterly granularity; CRA accepts sub-quarter payments — Phase 4 PR 1 stores any cadence in the `paid_on` date.
