# Cashflow Primitives — Convergence Map

**Date:** 2026-05-30
**Spec:** `2026-05-30-cashflow-primitives-design.md`

Each existing fork converges to the spine. Trigger is either **do-now** (cheap,
ready) or **fold-on-touch** (fold when you next touch the cluster for a feature).
No big-bang migration. The build rule prevents *new* forks; this map drains the
*existing* ones.

| Fold | Target primitive | Issue | Risk | Dep | Trigger |
|------|------------------|-------|------|-----|---------|
| tax-personal + tax-corp + tax-household scenario routes → one `/tax-scenarios` | Scenario | #377 | low (table already unified, controller fold) | none | do-now |
| notification preferences → `/users/me/...` + collapse Notification services | (Support transport) | #379 | low | none | do-now |
| AI queues + proposal-apply → unified `/review-items` read; writes stay per-source | Proposal + Observation | #378 | medium (read-side only; status-mapping table in AC) | spine adopted | do-now |
| PlannedEvent + Subscription → one Expectation (cadence = field); MoneyLeak becomes a derived view | Expectation | NEW | medium-high (data migration; MoneyLeak demotion) | none | fold-on-touch (touches #291 subscription cadence) |
| statement-reconcile path → lives under Account, not a parallel `/statements` primitive | Account | NEW | medium | none | fold-on-touch (touches #287 account merge, #305 dividend recon) |
| `/forecast` + `/forecast/safe-to-spend` → one forecast derivation with views | Scenario (projection) | NEW | low-medium | none | fold-on-touch (touches #213 scenario planner) |

## Order

1. **do-now, no deps:** #377, #379 — pure folds, table/service already aligned.
2. **do-now, spine-dependent:** #378 — needs the Proposal/Observation split (now
   defined in the spec). Read-side only; safe.
3. **fold-on-touch:** the three NEW issues. Do not schedule standalone. When a
   feature touches the cluster (subscriptions, statements/accounts, forecast),
   fold first, then build the feature on the folded primitive.

## Demotions (not folds — deletions of false primitives)

- **MoneyLeak** → a derived view over unused Expectations. Remove the model when
  the Expectation fold lands; reimplement as a query.
