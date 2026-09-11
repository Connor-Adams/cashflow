# Task 7 report: `forceReprocess` for the existing 141 orders

## What was done

Followed TDD per `superpowers:test-driven-development`.

### 1. Test file (written first, colocated)

`backend/src/integrations/scanReceiptsReprocess.test.ts` — new file, following the
seeding/auth conventions in `backend/src/integrations/scanReceiptsOrderDate.test.ts`
(same `deps` DI seam: `listMessageIds`, `fetchMessage`, `extractFromText`; same
`before`/`beforeEach` pattern with `Household`/`User`/`UserEmailIntegration` seeded,
`sequelize.sync({ force: true })`).

Deviations from the brief's sketch (the brief says its scaffolding is a sketch and
its assertions are the requirement):

- **Added a `ProcessedEmailMessage` row in tests 2 and 3, not just test 1.** The
  brief's sketch only seeded the "seen" row in test 1. Without it, tests 2/3 would
  pass trivially even with a broken/missing `forceReprocessMessageIds` bypass,
  because the message would never have been in the `seen` set to begin with. Seeding
  it in all three tests means the backfill tests actually exercise "bypass the skip
  guard because of forceReprocess," not just "findOrCreate backfills nulls."
- **Fixed the seeded `dedupeKey` to match what `scanInbox` actually computes.** I
  ran the real Amazon parser against the brief's `BODY` fixture and confirmed it
  returns `orderDate: null` and `items: []` for that text (no "Placed on" line, no
  item title line before `Quantity:`). `scanInbox` builds
  `dedupeKey = [vendor, orderId, orderDate, total, itemCount, msgId].join(':')`, so
  the correct key is `amazon:701-9999999-8888888::44.97:0:msg-repro` (empty
  orderDate segment, itemCount `0`) — not the brief's
  `amazon:701-9999999-8888888:44.97:1:msg-repro`. With the brief's literal key,
  `findOrCreate` would never match the pre-seeded row (it would insert a second
  row instead), and the backfill would silently never run against the row the test
  asserts on. This was caught precisely because I ran the test and watched it fail
  for the wrong reason first (order date stayed null because a *new* order was
  created, not because the feature was unimplemented) — then fixed the fixture
  before re-verifying against the real implementation.
- **`total` assertion uses `Number(order.total)` instead of a string literal.**
  SQLite/Sequelize round-trips `DECIMAL` columns as JS numbers on this codebase
  (confirmed against existing precedent: `amazonPipeline.test.ts` asserts
  `order!.total` as a bare number, and `vendorCapture.test.ts` wraps it in
  `Number(...)`). `assert.equal` from `node:assert/strict` is strict equality, so
  comparing to the string `'99.99'` fails on a type mismatch unrelated to the
  feature under test.

### 2. Implementation — `backend/src/integrations/scanReceipts.ts`

- Added `forceReprocessMessageIds?: string[]` to `scanInbox`'s options type,
  alongside `sinceDateOverride`, with the doc comment from the brief verbatim.
- Immediately after the `seen` set is populated: `for (const id of
  opts.forceReprocessMessageIds ?? []) seen.delete(id);`
- In the `findOrCreate` transaction block, after `result.orderCreated =
  createdOrder;`: when `!createdOrder` (row already existed), compute a
  `backfill` object that only sets `orderDate`, `total`, `subtotal`, `tax`,
  `paymentLast4`, `vendorOrderId` when the **existing** field is `null` AND the
  freshly-extracted value is non-null (orderDate additionally falls back to
  `dateFromInternalDate(full.internalDate)`, imported from
  `backend/src/integrations/internalDate.ts` per Task 1 — not reimplemented).
  Calls `order.update(backfill, { transaction: t })` only if there's something to
  fill. No field with an existing value is ever touched.

## Test commands run and output

1. Failing-test verification (pre-implementation):
   `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanReceiptsReprocess.test.ts`
   → 1 pass, 2 fail as expected (`skippedAlreadySeen` test passed trivially since
   the skip guard already existed; the two backfill tests failed — first because
   `forceReprocessMessageIds` didn't exist yet, then again after fixing the
   dedupeKey fixture, this time genuinely because the backfill code didn't exist).

2. Post-implementation, same file:
   ```
   ok 1 - a seen message is skipped without forceReprocess
   ok 2 - forceReprocess backfills null fields on an existing order
   ok 3 - forceReprocess never overwrites a non-null field
   # tests 3
   # pass 3
   # fail 0
   ```

3. Backend typecheck: `yarn workspace cashflow-backend run typecheck` → clean,
   no output (no errors).

4. Full integrations suite (required before commit, since `scanInbox` is exercised
   by many other test files):
   `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/*.test.ts`
   ```
   1..77
   # tests 77
   # suites 0
   # pass 77
   # fail 0
   # cancelled 0
   # skipped 0
   # todo 0
   ```
   All 77 tests across every `backend/src/integrations/*.test.ts` file pass,
   confirming the new option and seen-set/backfill changes didn't regress any
   existing `scanInbox` consumer.

## Concerns

- A `SQLITE_ERROR: near "ILIKE": syntax error` appears in the log output for every
  test that exercises `scanInbox`'s post-commit `runInteracCounterpartySync` step
  (Postgres-only `ILIKE` operator run against the SQLite test DB). This is
  pre-existing, unrelated to this change, caught internally as a `logger.warn` (the
  code treats it as best-effort and never lets it fail the scan), and present in
  the baseline before my changes too — not introduced by this task. Flagging per
  the project's "Cashflow is Postgres-only, never SQLite" note in case it's worth a
  separate follow-up to make that sync SQLite-safe for local dev/tests, but it is
  out of scope here and does not affect correctness of `forceReprocessMessageIds`.
- This task only adds the mechanism (`forceReprocessMessageIds` option). It does
  not itself include a script/route that enumerates the 141 production orders and
  calls `scanInbox` with their Gmail message ids — that wiring (reading
  `ExternalOrder.rawPayload.gmailMessageId` for orders with `order_date IS NULL`
  and invoking the backfill) is presumably a separate task/step in the plan, not
  mentioned in this brief beyond "so those orders can be re-parsed against Gmail."
  No such caller was requested or written.
