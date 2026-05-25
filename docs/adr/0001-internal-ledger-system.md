# ADR 0001: Internal ledger as the canonical money-movement representation

- Status: Proposed
- Date: 2026-05-25
- Deciders: Connor
- Supersedes: —
- Related work: PR #159 (cross-source dedup importer for WS activities-export), PR #160 (CRYPTORWD parser fix), PR #161 (widen invest quantity precision)

## Context

The cashflow app currently models money movement across two parallel tables:

- `transactions` — cash-side rows (`merchantRaw`, `amount`, `currency`, `accountId`, …). Cash dedup uses `stableIdentityFingerprint(accountId, date, amount, currency, merchantRaw)` with NULL-source-reference wildcard semantics.
- `investment_activities` — security-linked rows (`activityType`, `tradeDate`, `settlementDate`, `quantity`, `price`, `amount`, `securityId`, `fees`). Dedup uses an audit `sourceRowFingerprint` plus, as of PR #159, a fuzzy ±5-day identity-tuple matcher for cross-source overlap.

Each row carries a `direction` only implicitly (sign of `amount`), and each table independently models the same underlying domain concept: "money or asset moved between principals on a given date". The investment-activity row stores a cash *amount* on most types but its semantics differ between rows — e.g. a `dividend` row's amount is income received, a `buy` row's amount is cash paid out, a `staking_reward` row's amount is sometimes 0 because the value lives on a sibling row that gets filtered upstream.

The cross-source dedup work in PR #159 surfaced several pain points that suggest the current shape is the wrong factoring:

1. **Sign convention drift between sources.** Wealthsimple's activities-export signs SELL quantities negative (shares leaving) and BUY positive; the monthly-statement parser stores both as `abs(quantity)` and lets `activityType` carry direction. The dedup matcher has to `Math.abs()` to compare. Different sources also disagree on amount signs in some flavours (e.g. `BonusPayment/CASHBACK` shows positive in CSV; spend rows have signed amounts inconsistently across sources).
2. **The same logical event splits across both tables.** A BUY trade emits both an `InvestmentActivity` (the security position change) and a `Transaction` (the cash outflow). A `Dividend` emits an `InvestmentActivity` (the dividend record) but the cash credit lives in the monthly statement as a separate row. There is no foreign key linking the two; reconciliation depends on date + amount + symbol matching.
3. **No first-class "leg" of a money movement.** Today, an "ETH staking reward" event is represented as (a) an InvestmentActivity with `amount=0` because the CAD-half has no dollar value, (b) a Transaction row with `amount=0` and `merchantRaw="0.002 of DOT rewards earned"`, and (c) implicitly a Security position increment (no row, just inferred from the quantity on InvestmentActivity). The dollar value of the reward lives on a third row that gets filtered upstream because it has `amount=0 currency=USD`.
4. **`settlement_date` vs `trade_date` semantics differ silently between sources** (the headline finding behind the ±5-day fuzzy window). The fact that two columns can mean different things depending on which importer wrote them is a sign the schema is encoding "where this came from" rather than "what it is".
5. **Crypto precision** (PR #161): activities-export sources crypto positions at 10 decimals, but the current model stores 8. Different sources need different scales and rounding rules; the table-per-source layout has been propagating those decisions into the schema rather than into the source-level adapter.

## Decision (proposed)

Introduce a single `ledger_entries` table that represents one *leg* of one money or asset movement, with paired entries (debit + credit) for any single event. Existing tables become **views** or are kept as **denormalized materializations** for query convenience.

Sketch:

```
ledger_entries
  id              bigserial
  event_id        uuid              -- groups paired legs of one event
  occurred_at     date              -- when the movement happened economically
  posted_at       date              -- when the movement settled (NULL when unknown)
  account_id      int               -- internal account (chequing, TFSA, …)
  asset_kind      enum              -- 'cash' | 'security' | 'crypto'
  asset_id        int               -- securities.id when asset_kind != 'cash'
  currency        char(3)           -- ISO 4217 for cash, null for securities
  direction       enum              -- 'debit' | 'credit'
  amount          numeric(28,10)    -- always positive; direction carries sign
  source_kind     enum              -- 'ws_monthly_statement' | 'ws_activities_export' | 'manual' | …
  source_ref      jsonb             -- (file, batch, row_index, raw_fingerprint, etc.)
  notes           text
```

Every event has at least two legs. Examples:

- **Cash purchase of stock**: one debit leg (cash leaves account), one credit leg (security increases). Shared `event_id`.
- **Dividend received**: one credit leg (cash enters account from external "issuer" account or null counterparty).
- **Inter-account transfer**: two cash legs (debit one account, credit another), same `event_id`.
- **Staking reward**: one credit leg (crypto position grows). No paired cash leg until/unless WS pays it out in fiat.

Dedup becomes "do we already have an event whose legs match the incoming legs?" Identity is `(account_id, asset_id, direction, amount, currency, occurred_at)` per leg with a small date window if `posted_at` is unknown.

## Consequences

**Positive**

- Single source of truth for "money moved." Every report (cashflow, networth, portfolio) reads from one table.
- Cross-source dedup becomes principled: same event → same legs → exact identity match (no fuzzy window beyond the trade-vs-settle ambiguity, which is already represented as `occurred_at` vs `posted_at`).
- Direction is explicit; sign-of-amount conventions stop varying by source.
- Multi-asset events (in-kind transfers, ETH/USD pairs) get one event with both legs, instead of two rows in two tables and a filter rule.
- Asset precision is per-asset, not per-row: a `numeric(28,10)` covers crypto and fiat without negotiation.

**Negative / cost**

- Substantial migration: backfill ledger entries from existing `transactions` (≈ thousands of rows) and `investment_activities` (≈ 1k rows now) preserving original sources and identity. Run as a one-time job, double-check totals, then begin reading from the new table.
- Every reporting query rewrites. Networth, cashflow summary, portfolio metrics, balance-at-date, the dashboard tiles — all read from the new shape. Keep the old tables as compatibility views during the transition (read path) but ledger becomes the canonical write path.
- Dedup rule needs reformulation per `source_kind`. The current PR #159 fuzzy matcher becomes one specialization (cross-source matching against the same logical event) rather than the only one.
- AI / enrichment pipeline currently keys off `transactions.merchantRaw`. The ledger entry's `notes` field would need to carry that; or AI runs over a join.

**Risk if we don't do this**

- The fuzzy ±5-day window in PR #159 is the smallest in a sequence of fuzz factors we'll keep adding as new import sources arrive (RBC investment statements, brokerage account exports, manual reconciliation tools). Each addition compounds the dedup surface area.
- Sign convention bugs keep recurring — every new source adds another `if (source === X) abs() else ...` branch in dedup, reporting, and enrichment.
- Crypto precision will keep tripping over the per-table scale (`investment_activities.quantity DECIMAL(20,8)` → 8dp truncation) until forced upgrades like PR #161, which themselves require careful migration sequencing.

## Alternatives considered

### A. Keep the two-table model; encode source-specific quirks in adapters

What we have today. Works for the current scale. The fuzzy-window machinery from PR #159 is a one-off cost that's already paid for the WS activities-export case. Future sources may need bespoke shims, but each one is small.

**Rejected because**: the fuzzy window is a symptom, not a solution. Every source after this one starts paying the same cost, and the dedup invariants get harder to reason about as the number of fuzz factors grows.

### B. Use double-entry bookkeeping primitives via an off-the-shelf library

E.g. plug in `transactional` or `ledger-cli`-style accounting libraries. They provide debits/credits, account hierarchies, currencies, postings.

**Rejected for now because**: the domain model has personal-finance concerns (review flags, household sharing, merchant enrichment, recurring detection, AI categorization) that don't map cleanly onto standard accounting libraries. The custom ledger sketched above keeps those concerns first-class.

### C. Event sourcing — every import emits an event, projections build the tables

Conceptually clean: ImportedRow events get reduced into ledger projections. Replay-able, time-travel debuggable.

**Rejected because**: too heavy a lift for the current team size. The ledger above already gets most of the benefit (single canonical write path) without the operational overhead of event store + projection workers + rebuild pipelines.

## Open questions

1. **External counterparty accounts.** A dividend credit's debit side is "the issuer." Do we model issuer accounts (one row per security paying out)? Or accept that some legs have `account_id = null` to mean "external"?
2. **FX**. A USD purchase from a CAD account: do we record both currencies' legs and link via a separate FX event, or roll the FX into the cash debit at the historical rate?
3. **Migration cutover.** Read from ledger immediately on day 1, or shadow-write for a period and reconcile? Recommend shadow-write for one full statement cycle.
4. **AI enrichment surface.** Should `notes` on the ledger entry carry `merchantRaw`-equivalent text, or do we keep a separate `cash_transaction_metadata` sidecar table? The first feels cleaner; the second is less invasive on the AI pipeline.

## Decision required

This ADR is **Proposed**, not Approved. Approval should happen only after:

- A migration spike that proves the backfill can produce reconciling totals against existing reporting (networth, cashflow summary)
- A sketch of the rewritten reporting queries that confirms the new shape is faster or at least not slower at p95
- An estimate of effort across import / reporting / AI / frontend, to compare against the rolling cost of continuing to extend the two-table model
