# Tax Phase 2 — Design

**Date:** 2026-05-24
**Status:** Active
**Author:** Connor Adams
**Context:** Builds on Phase 1 (PR #118 + #125). T-slip ingestion polish, deferred personal credits, missing data sources.

---

## Goals

1. Cover the deferred T1 personal credits so filing-grade math handles common scenarios beyond the basics.
2. Replace the SlipsTab JSON textarea with per-slip-type forms.
3. Surface slip-vs-computed divergences in a reconciliation queue.
4. Source donations, RRSP contributions, dividend eligibility, and age from explicit data instead of plan-1 defaults.
5. Defer T4/T5/T3 PDF parse to its own sub-project (own PR).

## PR plan

### PR 1: Backend data + credits engine additions
1. **New credits**: `disabilityCreditFederal`, `caregiverCreditFederal`, `tuitionCreditFederal`, `pensionIncomeCreditFederal`, `oasClawback`. Wire into `buildT1`.
2. **FHSA deduction**: extend `RrspContrib` or add `FhsaContrib` to `TaxYearFacts`; deduct from net income (L23300).
3. **Donations**: add `donations: IncomeItem[]` to `TaxYearFacts`; builder reads transactions where `finalCategory='donations'`. Wire into existing `donationCreditFederal` / `donationCreditOntario`.
4. **Dividend eligibility per-Security**: add `Security.dividendEligibility ENUM('eligible','non_eligible','unknown') DEFAULT 'eligible'`. Builder reads this. Migration + model edit.
5. **RRSP contribution detection**: builder treats `finalCategory IN ('rrsp_contribution','fhsa_contribution')` as contribution; routes to `rrspContribs` / `fhsaContribs`.
6. **User DOB → ageAtYearEnd**: add `User.dob DATEONLY` column; builder computes `ageAtYearEnd = year - dob.year` (with adjustment if dob month/day > year-end).
7. **Rate-table additions**: federal DTC base amount + supplement, caregiver amounts/thresholds, tuition is sum of fees (no rate-table entry), pension income amount cap ($2,000), OAS clawback threshold + rate (~15% above $90,997 in 2024).

Engine tests for each new credit. Builder tests for new data sources.

### PR 2: Slip UI + reconciliation queue
1. `frontend/src/pages/tax/slips/T4Form.tsx`, `T5Form.tsx`, `T3Form.tsx`, `T4AForm.tsx`, `T5008Form.tsx` — explicit named-box inputs per slip type.
2. `SlipsTab` lets user pick type → renders corresponding form.
3. New `ReconciliationTab` (or section in Overview) — lists `TaxReturn.warnings` items where slip-vs-computed divergence exceeded threshold. Each has "Accept slip" / "Use computed" buttons (Phase 2 records preference; Phase 3 will surface in T2).

### PR 3 (deferred): PDF parse for T4/T5/T3
- Own sub-project under existing PDF receipt-parsing infrastructure.

## Out of scope (Phase 2)
- Corp T2 (Phase 3)
- Carryforward auto-roll (Phase 4)
- Scenario optimizer (Phase 5)
- T2125 explicit model (still uses Transaction.business=true)

## Risks
- DOB on User is sensitive PII — store with same access controls as existing User fields. No new RBAC change.
- Donation transactions: existing user may have categorized donations differently — Phase 2 builder picks up only `finalCategory='donations'`; surface a one-time backfill prompt later.
- Tuition/caregiver/DTC eligibility is filer-declared, not auto-detectable from transactions. Phase 2 ships engine-side support; UI for declaring eligibility comes in Phase 4 or later.
