# Cashflow — build guidance for Claude

## Primitives spine (READ BEFORE ADDING ANY MODEL, ROUTE, OR PAGE)

Cashflow is built on **13 canonical primitives**. A primitive is a distinct
*status machine + noun*, not a data shape. Full spec:
`docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md`.

The 13: **Transaction, Expectation, Account, Holding, Principal, Counterparty,
Scenario, Budget, Goal, Proposal, Observation, Document, Period.**

### The build rule

Before creating any new model, route, or page, answer:

> **Does this introduce a new status machine, or a new variant/view of an
> existing primitive?**

- **New variant** → add a `type`/`kind` field to the existing primitive.
- **New view** → add a query/derivation. No new table.
- **New behavior** → add a field or computed property to the owning primitive.
- **New status machine** → a new primitive. RARE. You must name its lifecycle and
  show it is not an existing machine wearing a new shape. Flag this explicitly in
  the PR — it is a spine change, not a feature.
- **Mirrors an existing machine** → STOP. It is a fork. Fold via a discriminator
  field instead.

Three checks, in order:
1. Which of the 13 does this extend? Exactly one → extend it. None → new primitive
   (justify) or the requirement is confused. Multiple → you are adding a
   relation/view, not a thing.
2. Persistent state or derived? Derived → no table, add computation. Persistent →
   which primitive owns it? Add a column or child table.
3. Does the shape mirror an existing primitive under a new name? Yes → fold.

Do not fork same-machine objects; do not merge different-machine objects.
