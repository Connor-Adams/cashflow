# Cashflow Primitives Spine

**Date:** 2026-05-30
**Status:** Adopted
**Type:** Architecture / build discipline (not a feature spec)

## Problem

Cashflow has ~55 user-facing features across 77 models, 65 backend routes, 60
frontend pages — built for one household, trending toward wider use. The 2026-05-29
duplication audit found 7 overlap clusters covering ~27% of the surface (tax
scenarios ×3, AI queues ×3, recurring-spend ×3, proposal-apply ×2, reconciliation
×2, forecast ×2, notification ×3).

The duplication is a **symptom**, not the disease. Root cause: **no canonical
primitives.** When a new want appears ("track corp tax scenarios", "flag money
leaks", "CFO briefing"), it gets built as a *parallel table + route + page*
mirroring something that already exists, instead of *extending* the existing
object. The appetite to keep building is healthy and stays. What was missing is a
rule for "is this a new thing, or a new shape of an existing thing?"

This document defines that rule.

## Definition

A **primitive** is a canonical persistent object identified by a **distinct status
machine plus a noun** — not by its data shape.

The discriminant:

- Two objects are the **same primitive** iff they share a status machine *and* a
  noun. Different data shapes are fine — they're variants/views of one primitive.
- Two objects with the **same shape but different status machines** are **different
  primitives**.
- Two objects with the **same shape and same machine** under different names are a
  **fork** — collapse them.

Why lifecycle, not shape: shape drifts (you add columns); the lifecycle is the
contract. `ChatProposal` and `Insight` have similar shapes but
`pending→applied→rejected` vs `open→dismissed→resolved` are different contracts —
applying a Proposal *writes to another primitive*, resolving an Observation does
not. That difference is load-bearing; the shared columns are not.

### A primitive satisfies all four

1. **Single-noun identity** — answers "what is this thing?" in one word.
2. **Stable lifecycle** — a defined status machine with a terminal (or explicitly
   standing) state.
3. **Multi-expression** — the same object is viewed/filtered/derived many ways
   without forking the model.
4. **Variants by field, not parallel table** — `type: 'corp' | 'personal'`, never
   `CorpScenario` + `PersonalScenario`.

### Not a primitive (anti-patterns)

- **Twin tables** — two models with ~the same shape and different prefixes → fold
  to one + a `type`/`kind` discriminator.
- **Wrapper queues** — "Inbox"/"queue" objects wrapping another model → that's a
  *view*, not a primitive.
- **Persisted derivations** — a "summary"/"snapshot"/"leak" that is recomputable →
  a derivation. Persist only if computation is expensive *and* history is needed.
- **Flag hosts** — a noun that exists only to carry one boolean → a field on the
  parent.

## The Spine: 13 primitives

| Primitive | Status machine | Folds (current models) | Identity |
|-----------|----------------|------------------------|----------|
| **Transaction** | imported → categorized → reconciled | + TransactionRevision, TransactionSignal, TransactionOrderLink, TransactionTaxMetadata, TransactionReturnMetadata | posted money movement |
| **Expectation** | planned → posted → skipped / ignored / cancelled | PlannedEvent + Subscription folded into one table (`kind='planned'\|'subscription'`; `cadence` column for recurring) — shipped 2026-05-31 | *expected* money movement |
| **Account** | open → archived | + AccountStatement (period child, not a twin) | store of value |
| **Holding** | held → closed | + Security, SecurityPrice/Daily/Dividend (ref data); HoldingSnapshot, PortfolioDailySnapshot, ForwardProjection (derivations) | investment position |
| **Principal** | active | User, Household, HouseholdMember, Entity (`personal\|corp`) | who owns money |
| **Counterparty** | — (reference) | Contact + merchant identity | who you transact with |
| **Scenario** | baseline → fork → projection_root (already typed) | Scenario, ScenarioReturn, HouseholdPlan | what-if branch |
| **Budget** | standing (no terminal) | BudgetTarget + BudgetExclusion + BudgetAlertState | spend constraint |
| **Goal** | active → paused → completed | FinancialGoal | savings target |
| **Proposal** | pending → applied → rejected / expired | AiSuggestion + ChatProposal | system asks to write |
| **Observation** | open → dismissed → resolved | Insight + CfoBriefing action items + AiReviewRun items | system flags, no write |
| **Document** | captured → linked | Receipt + VaultDocument + ExternalOrder/Item/Tender + ProcessedEmailMessage (source = field) | captured artifact |
| **Period** | open → closed | MonthlyClosePeriod + MonthlyCloseTask + TaxReturn + TaxSlip | time-boxed close cycle |

### The two key folds

**Proposal vs Observation** (was: AI queues ×3 + proposal-apply ×2). One question
separates them: *does accepting it mutate another primitive?*

- **Proposal** — yes. Applying an `AiSuggestion` or `ChatProposal` writes to a
  Transaction/Budget/etc. Machine: `pending → applied → rejected`.
- **Observation** — no. An `Insight` or a `CfoBriefing` action item is flagged,
  then acknowledged. Machine: `open → dismissed → resolved`.

**Expectation** (was: recurring-spend ×3). `PlannedEvent` (one-shot future) and
`Subscription` (recurring) are the same noun — *money I expect to move* — with a
cadence field. `MoneyLeak` is **not a primitive**: it is a derived view over
Expectations (recurring spend that looks unused). Budgets/subscriptions/leaks felt
duplicated because *leaks was never a thing* — it's a lens.

### Support (deliberately not primitives)

- **Notification** + **NotificationPreference** — delivery channel for Proposal /
  Observation / Budget alerts. Not a primitive; a transport.
- **Job / JobRun / ProviderJobLog** — infra.
- **AuditLog**, **TransactionRevision** — cross-cutting history.
- **Category / TaxCategory / TaxTag / Rule / SavedSearch** — taxonomies. Candidate
  for a future single `Label` primitive (scope = field); revisit only if a fourth
  taxonomy appears.
- **FxRate / SecurityPrice** — reference data.
- **CashflowSettings / Session / UserCaptureToken / UserEmailIntegration /
  SyncBackup / ImportHistory** — infra, auth, state.

## The Build Rule

Before creating any new model, route, or page, answer one question:

> **Does this introduce a new status machine, or a new variant/view of an existing
> primitive?**

- **New status machine** → a new primitive. Rare. You must be able to name its
  lifecycle and show it is not an existing machine wearing a new shape.
- **New variant** → add a `type`/`kind` field to the existing primitive.
- **New view** → add a query/derivation. No new table.
- **New behavior** → add a field or computed property to the owning primitive.
- **Mirrors an existing machine** → STOP. It's a fork. Fold via discriminator.

Three checks, in order:

1. **Which of the 13 does this extend?** Exactly one → extend it. None → new
   primitive (justify the lifecycle) *or* the requirement is confused. Multiple →
   you're adding a relation/view, not a thing.
2. **Persistent state or derived?** Derived → no table, add computation.
   Persistent → which primitive owns it? Add column or child table.
3. **Does the shape mirror an existing primitive under a new name?** Yes → fold.

This keeps appetite unbounded while keeping the surface coherent. "I want a corp
tax planner" → extends **Scenario** (`kind` field), not a new `tax-corp-scenarios`
table. "I want regret scoring" → a derived field on **Transaction**, not a
`RegretScore` model. "I want a CFO briefing" → an **Observation** source, not a new
queue.

### Primitives lifecycle (avoiding the inverse failure)

Merging things with *different* machines into one god-object is the same mistake as
forking, inverted. Budget (standing constraint), Goal (accumulates to target), and
Scenario (what-if branch) share a vague theme ("intent about money") but have three
different machines — they stay three primitives. The rule cuts both ways: don't
fork same-machine objects, don't merge different-machine objects.

## Convergence path (current → spine)

The spine describes the target. Existing forks converge opportunistically — not a
big-bang migration. Already-filed fold issues align:

- **#377** tax-personal + tax-corp scenarios → one `/tax-scenarios` route. The
  `Scenario` table is *already* unified; this is a pure controller fold. → **Scenario**
- **#378** unified `/review-items` read endpoint + single filterable inbox. Read-side
  only; writes stay per-source. → splits across **Proposal** / **Observation**
- **#379** fold notification preferences + collapse the two notification services.
  → **Support** (Notification transport)

Next folds to file as they surface (not yet issues):

- PlannedEvent + Subscription → **Expectation** (add `cadence`; MoneyLeak becomes a
  view).
- Statement-reconcile lives under **Account**, not a parallel `/statements` primitive.
- `/forecast` + `/forecast/safe-to-spend` → one forecast derivation with views.

Rule of thumb: fold when you next touch a cluster for a feature reason, not as
standalone refactor churn. The build rule prevents *new* forks from day one; the
convergence path drains the *existing* backlog as you go.

## Enforcement

1. This document is the reference for the spine.
2. Add the build-rule question to the issue/PR template: *"Which primitive does this
   extend? (or: what new lifecycle justifies a new primitive?)"*
3. Add a short pointer in the repo's build guidance so the rule is applied at
   authoring time, not discovered at audit time.

## Open items

- **Principal** is the most ambitious fold (User + Household + Member + Entity). It
  is listed as one primitive because they form one "who owns money" graph, but the
  collapse is conceptual — the tables stay distinct. Revisit if multi-tenant /
  wider-than-household use forces a real identity refactor.
- **ExternalOrder** sits under **Document** (a captured artifact that links to
  Transactions) but is a close call with Transaction itself. Kept as Document
  because it is a *source record*, not the money movement.
- **Label** primitive (folding Category/TaxTag/Rule/SavedSearch) is deferred — only
  pursue if a fourth taxonomy appears.
