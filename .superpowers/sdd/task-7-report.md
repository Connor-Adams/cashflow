# Task 7 report: the People ledger frontend

> Note: this file previously held a report for an unrelated `forceReprocess`
> task (a different plan). It has been overwritten with the Task 7 report.

## Summary

The page now leads with `loanBalance` — the signed, per-currency debt — and
demotes `transferNet` to a described raw flow that makes no debt claim. Every
currency is represented in both the headline metric and the bar; the previous
CAD-or-first pick is gone. Transfers gained a role `<select>`, a
cancelled-pair treatment, a mismatch warning, and the contact header gained a
`loanDefault` toggle.

## What was done

### Steps 1–4: the label functions (strict TDD)

`frontend/src/lib/peopleLedger.test.ts` rewritten with the brief's four
assertions (exact expected strings preserved verbatim; wrapped in the file's
existing `describe`/`it` idiom rather than bare `test`, since the rest of the
frontend suite uses explicit vitest imports).

`frontend/src/lib/peopleLedger.ts` replaced: `formatNetLabel` deleted,
`formatBalanceLabel` + `formatNetFlowLabel` added.

The whole point of this task lives in these two functions:

- `formatBalanceLabel` → `owed to you` / `you owe` / `settled`. Only this.
- `formatNetFlowLabel` → `net out` / `net in`. Never a debt word.

### Step 5: the page

`frontend/src/pages/PeopleLedgerPage.tsx`:

- **`deriveMetrics`** now returns
  `{ balanceByCurrency: Map<string, { owedToYou, youOwe }>, trackedLoansCount }`,
  summing `ledger.loanBalance` across every currency rather than taking the CAD
  row or `[0]`, so a USD balance can no longer be silently dropped behind a CAD
  one. (It started as the brief's `Map<string, number>`; the split into two
  directions came out of review — see "Second-pass review" below.) The landing
  headline renders a tile per currency per direction.
- **`computeBarSegments`** now reads `loanBalance` (lent vs repaid) instead of
  `transferNet` (sent vs received), and returns one segment per currency that
  has something lent. `NetBar` was renamed **`LoanBar`** and renders one bar per
  currency. A contact with no tracked lending renders no bar and net-flow text
  only.
- **`peakBalance`** is the new landing sort key — largest absolute balance in
  any currency. The page leads with the balance, so it sorts by the balance.
- **Landing table** gained a `Loan balance` column ahead of the (renamed)
  `Raw transfer flow` column; `LANDING_COL_COUNT` = 5 covers the skeleton and
  empty rows. A contact with no balance reads `No tracked loans`, not `—`, so
  the absence is a statement rather than a blank.
- **Drill-in summary** leads with `Loan balance`, then `Raw transfer flow`
  (captioned "Everything that moved between you — not a debt."), then the
  pre-existing `Tracked loans outstanding`.
- **Role `<select>`** per transfer row (`RoleSelect`), options
  `COUNTERPARTY_ROLES` with display labels plus an empty
  `Auto (contact default)` entry. Calls `setCounterpartyRole(t.id, value)`,
  then **refetches the ledger** — see "Deviations / context" below.
- **`cancelled: true`** → row rendered `text-muted-foreground line-through`
  with `title="cancelled e-transfer pair"`. Its role select and its "Mark as
  loan" button are suppressed: tagging a cancelled leg means nothing.
- **`roleMismatch: true`** → `<Badge variant="destructive">tag disagrees with
  direction</Badge>` on the row, plus a card-level summary line
  ("N transfers are tagged against their direction. Direction wins.").
- **`loanDefault` toggle** in the contact header — DS `Switch` + `Label`,
  calling `setContactLoanDefault(contact.id, next)` then reloading.
- `TRANSFER_COL_COUNT` 5 → 6.
- `reload()` became `async` and every caller now awaits it, so a write and its
  refetch can't interleave with the next click.

`frontend/src/lib/api.ts`: added `setCounterpartyRole` and
`setContactLoanDefault` exactly as the brief specifies, plus a doc comment on
the former recording that the PATCH response does not echo the role back.

### Single source of truth for the role vocabulary (beyond the brief)

The brief says the `<select>` options come from `COUNTERPARTY_ROLES`, but that
const lived in `backend/src/contacts/counterpartyRole.ts`, which the frontend
cannot import. Rather than duplicate the list (a guaranteed drift hazard
between the validator and the dropdown), I moved it into
`shared/api-types.ts` — which already carries exactly this pattern for
`TAX_TREATMENTS` / `isTaxTreatment` — and had the backend module re-export it:

```ts
import { COUNTERPARTY_ROLES } from '@cashflow/shared';
export { COUNTERPARTY_ROLES };
```

`CounterpartyRole` is now derived from the array
(`(typeof COUNTERPARTY_ROLES)[number]`) instead of being a hand-maintained
union, so the two can no longer disagree. Every existing backend call site
still imports from `counterpartyRole.ts` unchanged. The brief's Step 8 stages
`shared`, which suggests this was anticipated. Backend already imports runtime
values from `@cashflow/shared` elsewhere (`isTaxTreatment` in
`buildPersonalFacts.ts`), so this adds no new dependency edge.

### Step 6: the page test

`frontend/src/pages/PeopleLedgerPage.test.tsx` fixtures updated with
`loanDefault`, `loanBalance`, and the four new row fields. The fixture
deliberately gives Caelan a CAD balance of 480 *and* a raw net of 480 from
different components (lent 500 / repaid 20 vs sent 550 / received 70) so the
two numbers are distinguishable in assertions.

New tests (14 total in the file, up from 5):

| Test | What it locks |
|---|---|
| leads with the loan balance, and labels raw flow without a debt claim | balance cell says "owed to you"; net cell says "net out" and matches `not.toMatch(/owed\|you owe/i)` |
| shows one balance metric per currency instead of dropping all but the first | CAD **and** USD −3,570.51 both render |
| makes no owed or owe claim for a contact with no loan balance | 43k of raw flow, `loanBalance: []` → nothing on the row or in the metrics says "owed"/"owe" (**this is the brief's required test**) |
| tags a transfer via the role select and refetches the ledger | `setCounterpartyRole(10, 'loan')` **and** a subsequent `getContactLedger` call |
| clears a tag back to the contact default with the auto option | select shows `loan`; picking `''` sends `null` |
| strikes through a cancelled e-transfer leg and says why | `line-through` class + `title="cancelled e-transfer pair"` |
| warns when a tag disagrees with the direction | row badge text + card summary |
| toggles the contact loanDefault | `setContactLoanDefault(1, true)` |
| shows raw bank text in the merchant column | `e-Transfer sent Caelan` renders |

## Test commands and output

### RED — label functions (Step 2)

```
$ yarn workspace frontend run test peopleLedger
 FAIL  src/lib/peopleLedger.test.ts > formatBalanceLabel > a zero balance is settled
TypeError: (0 , formatBalanceLabel) is not a function
 FAIL  src/lib/peopleLedger.test.ts > formatNetFlowLabel > net flow carries no owed or owe claim
TypeError: (0 , formatNetFlowLabel) is not a function

 Test Files  1 failed | 1 passed (2)
      Tests  4 failed | 6 passed (10)
```

(All four new assertions fail for the right reason: the functions don't exist.)

### GREEN — label functions (Step 4)

```
$ yarn workspace frontend run test src/lib/peopleLedger.test.ts
 ✓ src/lib/peopleLedger.test.ts (4 tests) 1ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

### GREEN — page

```
$ yarn workspace frontend run test PeopleLedgerPage
 ✓ src/pages/PeopleLedgerPage.test.tsx (14 tests) 207ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
```

### Mutation check — are the new tests non-vacuous?

Because the page tests passed on the first run, I verified they actually bite
by temporarily reintroducing both original bugs:

- **Mutation A** — `formatNetFlowLabel` reverted to the old
  `'owed to you' / 'you owe' / 'settled'` labels.
- **Mutation B** — `deriveMetrics` reverted to
  `loanBalance.find(b => b.currency === 'CAD') ?? loanBalance[0]`.

```
   × leads with the loan balance, and labels raw flow without a debt claim
   × shows one balance metric per currency instead of dropping all but the first
   × makes no owed or owe claim for a contact with no loan balance
   × shows the balance, the raw flow, and the tracked balance for a selected contact
      Tests  4 failed | 10 passed (14)
```

Exactly the four intended tests failed and no others. Both mutations were then
reverted and the file re-verified at 14/14.

### Full frontend suite + lint (Step 7)

```
$ yarn workspace frontend run test
 Test Files  218 passed (218)
      Tests  1212 passed (1212)

$ yarn workspace frontend run lint
(no output — clean)
```

### CI (Step 8)

`yarn ci` runs, in order: workflows → shared test → backend typecheck →
backend unit → **backend integration** → backend build → frontend test →
frontend build → frontend lint → frontend lint:palette.

Every step passes **except the integration step, which cannot run in this
environment** — it needs Postgres via `TEST_DATABASE_URL`, and there is no
local Postgres (`pg_isready` → `/tmp:5432 - no response`) and the Docker
daemon is down, so a container cannot be started either. Failures are all
`ECONNREFUSED` at the `before` hook, i.e. connection, not assertion. Per
`CLAUDE.md`, CI runs these in a dedicated job with a Postgres service.

Each step run individually:

```
$ yarn test:workflows                              # fail 0
$ yarn workspace @cashflow/shared run test         # fail 0
$ yarn workspace cashflow-backend run typecheck    # clean, exit 0
$ yarn workspace cashflow-backend run test         # tests 4559, pass 4535, fail 0, skipped 24
$ yarn workspace cashflow-backend run test:integration
    ECONNREFUSED — no Postgres available in this environment (see above)
$ yarn workspace cashflow-backend run build        # exit 0
$ yarn workspace frontend run test                 # 218 files, 1212 tests, 0 fail
$ yarn workspace frontend run build                # ✓ built
$ yarn workspace frontend run lint                 # clean
$ yarn workspace frontend run lint:palette         # 377 files clean
```

The 4,535 backend unit tests passing is the relevant signal for the one
backend file I touched (`counterpartyRole.ts`), whose unit tests
(`counterpartyRole.test.ts`, `loanBalance.test.ts`, `counterpartyRolePatch.test.ts`)
all still pass against the re-exported vocabulary.

## Decision: `mismatchedRowCount`

**Consume the per-row `roleMismatch` field; the backend helper is dead code.**

`backend/src/contacts/loanBalance.ts:73` `mismatchedRowCount` has no consumer
outside its own test. The route already ships `roleMismatch` on every row
(`backend/src/routes/contacts.ts:362`), which is strictly more information: the
frontend needs to mark *which* rows conflict, not just how many. Deriving the
count from the rows it already has (`countMismatches` in the page) means the
badge and the summary line can never disagree — with two sources they could,
since the route zeroes `roleMismatch` for cancelled rows
(`isCancelled ? false : mismatch`) while `mismatchedRowCount` is computed over
the pre-cancellation row set and would count a cancelled leg's stale tag.

So it is not merely unused, it would be *wrong* to use here. I did not invent a
speculative consumer and I did not delete it either — deleting backend code is
outside this task's file list, and Tasks 1–6 are already committed. **Flagging
it for removal**: either delete `mismatchedRowCount` and its test, or, if a
future aggregate view wants a household-wide mismatch count, rebuild it over
the post-cancellation row set so it agrees with what the route serves.

## Deviations from the brief, and why

1. **`computeBarSegments` returns `BarSegment[]`, not `T | null`.** The brief
   says "returns null when the contact has no balance". The per-currency
   requirement forces a list, so the "nothing to draw" signal is `[]` and
   `LoanBar` returns `null` on an empty array. Same behaviour, correct shape.

2. **`formatBalanceLabel` takes `Pick<LoanBalance, 'currency' | 'balance'>`
   rather than `LoanBalance`.** The brief's body reads only those two fields.
   The landing metric holds an *aggregated* per-currency total with no
   meaningful `lent`/`repaid` components; widening the parameter lets it call
   the real labeller instead of duplicating the owed/owe/settled wording
   inline — which is the exact wording this task exists to keep in one place.
   The brief's literal test assertions pass unchanged.

3. **`COUNTERPARTY_ROLES` moved to `shared/api-types.ts`** (backend re-exports).
   Rationale above; the alternative was a duplicated vocabulary.

4. **Landing table gained a `Loan balance` column and now sorts by balance.**
   Not in the brief's change list, but leading the headline with the balance
   while the table still ranked and displayed only raw net would have been
   incoherent — a contact with 43k of flow and zero debt would still have sat
   at the top of the list.

5. **`NetBar` renamed `LoanBar`.** It no longer draws a net; keeping the old
   name would have been the same category error as the old labels.

6. **`reload()` is now `async` and awaited by all callers.** The brief just
   says "reload"; making it awaitable is what lets the role-select test assert
   the refetch happened, and prevents overlapping writes racing their refetches.

7. **Mismatch badge uses `variant="destructive"`.** The brief says "warning
   badge"; the DS `BadgeVariant` union is
   `default | secondary | destructive | outline | success | count` — there is
   no `warning`. `destructive` is the DS's attention variant, and the rules
   forbid restyling a DS component via `className` to invent one.

## Self-review findings

- **Verified the invariant holds in the negative case.** The brief's required
  test ("a contact whose `loanBalance` is `[]` renders no owed/owe language")
  asserts on `contactRow.textContent` and the metrics container with
  `not.toMatch(/owed|you owe/i)` — a whole-subtree check, not a single element,
  so a stray debt word anywhere in the row fails it.
- **Design system used as-is.** New DS components (`NativeSelect`, `Switch`,
  `Label`, `Badge`) carry no styling `className`. The only `className` on DS
  primitives is the pre-existing layout/state idiom already in this file
  (`cursor-pointer hover:bg-muted/50`, `min-w-32`) plus
  `text-muted-foreground line-through` on a cancelled `TableRow`. That last one
  is row *state*, not a restyle of the DS's table design — but it is the one
  judgement call worth naming. `lint:palette` is clean over all 377 files.
- **No interpolated Tailwind classes.** All variant strings are literals;
  the only dynamic values are inline `style={{ width }}` percentages, which
  were already the file's approach for the bar and cannot be Tailwind classes.
- **`ROLE_LABELS` is `Record<CounterpartyRole, string>`**, so adding a role to
  `COUNTERPARTY_ROLES` breaks typecheck here rather than shipping a raw slug
  like `loc_interest` into the dropdown.
- **Divide-by-zero guarded**: `computeBarSegments` skips any currency where
  `lent` is 0 or non-finite before dividing.
- **Cancelled rows can't be tagged**: their role select is `disabled` and
  "Mark as loan" is hidden, so the struck-through row is genuinely inert.
- **Fixed during self-review: `reload()` no longer raises `ledgerLoading`.**
  The original `reload` set the page-level loading flag, which swaps the whole
  summary card and transfers table for "Loading…". That was tolerable when
  reload only fired on "Mark as loan"; with a role dropdown on every row it
  would blink the entire table away on each tag. The refetch now leaves the
  current ledger rendered and swaps it in when it arrives, and the control that
  was used is disabled for the duration (`savingRole` / `savingDefault`) as the
  localised affordance. A failed refetch leaves the previous ledger on screen
  rather than an empty page.
### Second-pass review (`pr-review-toolkit:code-reviewer`) and the fixes

I ran an independent reviewer over the diff. It confirmed the core invariant
holds, that no currency is dropped on any render path, that the DS rule is
respected, and that the tests are non-vacuous — and raised five issues, **all
five of which I fixed**. Two of them were the *same class of bug as the one
this task exists to fix*, which is exactly why they were worth catching:

1. **A failed ledger fetch rendered as `No tracked loans` — a false debt claim
   by omission.** `loadAll` swallowed per-contact fetch failures with
   `.catch(() => null)`, so a contact whose ledger 500'd fell into the "no
   balance" branch and was asserted to owe nothing, while also being silently
   dropped from the headline totals. Fixed: failures are collected into
   `failedLedgerIds`, the balance cell reads `Couldn't load`, and a destructive
   toast fires. **An unknown balance is not a zero balance.**

2. **The headline metric netted balances across contacts.** As the brief
   specified a single signed sum per currency, "Caelan owes you 480" and "you
   owe Stephen 480" cancelled into `CAD 0.00 settled` — a headline asserting
   nothing is outstanding over two live debts. This is the original bug one
   level up, so I deviated from the brief: `deriveMetrics` now returns
   `Map<string, { owedToYou, youOwe }>` and the two directions render as
   separate tiles (`Owed to you · CAD`, `You owe · CAD`). Totals now cross
   neither axis — not currency, not direction. Also added `roundCents` at the
   aggregate boundary so float accumulation can't leak a `1e-13` residue past
   the zero guard and print `CAD 0.00 owed to you`.

3. **`reload()` had no cancellation guard.** Removing `ledgerLoading` from it
   (my earlier fix) made an existing race worse: a refetch in flight when the
   user navigates to another contact would paint contact 1's name, balance and
   transfers onto contact 2's page, with nothing left to correct it. Fixed with
   a monotonic `ledgerRequestRef` token shared by the navigation effect and
   `reload`; a fetch applies its result only if it still holds the latest
   token. This also makes two rapid role tags settle on the newer answer
   instead of whichever response happened to land last.

4. **`aria-label` on a role-less `<div>`** (the bar track) is not exposed by
   assistive tech — dead markup that looked like coverage. Added `role="img"`.

5. **The role `<select>` was labelled with a database id** ("Role for
   transaction 10"). Now labelled with the row as the user sees it —
   `Role for 2020-01-01 Transfer CAD -200.00`.

Two new regression tests cover 1 and 2:

| Test | What it locks |
|---|---|
| does not net opposing debts across people into "settled" | +480 and −480 render as two tiles; metrics container `not.toMatch(/settled/i)` |
| says a balance could not be loaded rather than claiming there is none | failed fetch → `Couldn't load`, never `No tracked loans` |

Both were mutation-verified: reverting `deriveMetrics` to signed netting and
removing the failed-load branch failed exactly those tests (plus the
per-currency one) and no others.

Final gate after the review fixes:

```
$ yarn workspace frontend run test          # 218 files, 1214 tests, 0 fail
$ yarn workspace frontend run lint          # clean
$ yarn workspace frontend run lint:palette  # 377 files clean
$ yarn workspace frontend run build         # ✓ built
$ yarn workspace cashflow-backend run typecheck  # clean
```
- **Not addressed (out of scope):** `trackedOutstandingByCurrency` ("Tracked
  loans outstanding", driven by the older `isLoan` flag) now sits beside
  `loanBalance` and the two answer nearly the same question by different
  mechanisms. Folding the old one into the role-based balance is a data
  migration, not a UI change, and no task in this plan covers it. Worth a
  follow-up.

---

## Review round 2 — five findings fixed

Two IMPORTANT findings were the same false-claim bug class the task exists to
remove, one level up from the row. All five are fixed TDD: each test was added
first and observed failing (7 new page tests red, 2 green as guards) before any
implementation landed.

### Finding 1 (IMPORTANT) — the headline claimed "Nothing outstanding" over balances it could not load

`deriveMetrics` builds `balanceByCurrency` only from ledgers that loaded, so an
empty `balanceEntries` is ambiguous: it means "no debt" only when nothing
failed. The metrics card never consulted `failedLedgerIds`, so N failed fetches
rendered `Loan balance / Nothing outstanding` — a positive zero-debt assertion
over N unknown balances.

`PeopleLedgerPage.tsx` now derives, alongside `balanceEntries`:

- `failedCount` — `realContacts` ∩ `failedLedgerIds`
- `allBalancesUnknown` — every real contact's fetch failed
- `balancesIncomplete` — any failed

and branches three ways:

| state | Loan balance tile | caption |
|---|---|---|
| nothing failed | `Nothing outstanding` / the per-currency tiles | none |
| some failed | the tiles that did load, or `Incomplete` | `metrics-incomplete`, naming the count |
| all failed | `Couldn't load` — **no total at all** | `metrics-incomplete` |

The `Tracked loans` tile is derived from the same ledgers, so it renders `—`
rather than a bare `0` when nothing loaded (`0` would read as "none tracked").
This was found while fixing the finding, not reported in it.

`deriveMetrics`' doc comment claimed failures "are reported separately — see
`failedLedgerIds` at the call site", which was not true of this call site. It
now states that the totals are a floor rather than a sum, that the map cannot
distinguish "nobody owes anything" from "nothing could be loaded", and that
callers MUST pair it with `failedLedgerIds` before wording anything.

### Finding 2 (IMPORTANT) — two competing debt numbers with nothing distinguishing them

`Loan balance` (CAD 480.00 owed to you) and `Tracked loans outstanding`
(CAD 200.00) sat adjacent for the same contact with no explanation. Traced the
older number to its source to caption it accurately:
`backend/src/reimbursements/serialize.ts` `summarize()` — it is the sum of the
contact's Reimbursement rows whose effective status is `expected` or `overdue`,
i.e. claims logged **by hand**. It never reads `counterparty_role`, so it is a
different quantity from `loanBalance` and is not expected to agree with it.

Captions added (app-side `TileCaption` component + four exported string
constants, so drill-in and landing-column wording cannot drift apart):

- `tracked-outstanding-caption`: "Unpaid reimbursement claims you logged by
  hand. A separate, older tally that ignores transfer tags — the loan balance is
  this page's answer to what they owe you."
- `loan-balance-caption`: "What they owe you: every transfer tagged loan or
  repayment, netted. This page's answer."
- landing column captions for all three money columns (`Loan balance`,
  `Raw transfer flow`, `Outstanding loans`).

The existing raw-flow caption was folded into `TileCaption` unchanged. Folding
the two mechanisms together remains a data migration and is still out of scope.

### Finding 3 (MINOR) — `reload()` cancellation guard opened a stuck-loading state

The navigation effect cleared `ledgerLoading` only inside `if (isCurrent())`
and `reload` never cleared it, so a `reload` that bumped `ledgerRequestRef`
while the navigation fetch was in flight pinned `ledgerLoading` true forever —
the drill-in rendered "Loading…" over a populated ledger until the user
navigated away. Reachable from `onCommitLink`, whose button renders outside the
loading gate.

Fixed in `reload`, not the effect: clearing unconditionally in the effect would
regress a real case — navigation A finishing after navigation B started would
unveil A's stale ledger under B's heading. Instead `reload` clears the flag in a
token-guarded `finally`; whoever holds the token owns the flag.

The test drives the exact interleaving: the navigation fetch is left unresolved,
"Link transfers" fires `reload`, and the assertion is that the summary card
renders and "Loading…" is gone. It failed against the old code with a 1s
`findByTestId` timeout over a DOM containing only "Loading…".

### Finding 4 (MINOR) — orphan "Lent vs repaid" heading

The block was gated on `ledger.loanBalance.length > 0` while
`computeBarSegments` skips any currency with `lent === 0`. Stephen Masseur's
real USD row (lent 0 / repaid 3570.51 / balance −3570.51) rendered the heading
over nothing. Now gated on `computeBarSegments(ledger).length > 0`. Two tests:
the repaid-only row omits the heading, a normal lending row keeps it.

### Finding 5 (MINOR) — `formatBalanceLabel` read a non-numeric balance as "settled"

`Number(b.balance)` yields `NaN`, which fails both `> 0` and `< 0`, producing
`CAD NaN settled`. Extracted `parseAmount()` in `frontend/src/lib/peopleLedger.ts`
returning `number | null`, and both formatters now bail to `balance unknown` /
`flow unknown` instead of making a claim.

`parseAmount` also rejects `null`, `undefined` and the empty string, which the
finding did not mention: `Number('')` and `Number(null)` are both `0`, so a bare
`Number()` turns "no value" into the claim "settled" just as surely as `NaN`
did. `formatNetFlowLabel` got the same guard for the same reason.

### Verification

```
$ yarn workspace frontend run test PeopleLedgerPage
  Test Files  1 passed (1)        Tests  25 passed (25)     # was 16; +9 new

$ yarn workspace frontend run test peopleLedger
  Test Files  2 passed (2)        Tests  31 passed (31)     # lib 6 (+3), page 25

$ yarn workspace frontend run lint
  exit 0, clean

$ yarn ci
  FAILS — but only in the integration tier, which cannot run on this machine.
```

`yarn ci` aborts at `yarn workspace cashflow-backend run test:integration`:
1645 of 1698 subtests fail with `code: 'ECONNREFUSED'` / `failureType: 'hookFailed'`
before any assertion runs. Confirmed environmental, not caused by these changes:
`TEST_DATABASE_URL` is unset and a TCP probe of `127.0.0.1:5432` returns
`ECONNREFUSED` — there is no local Postgres. The changes here are frontend-only
and touch no backend code path. **The integration tier was NOT run; CI's
dedicated Postgres job is the gate for it.**

Every other `yarn ci` stage was run individually and passed:

```
$ yarn test:workflows                             # 76 pass, 0 fail
$ yarn workspace @cashflow/shared run test        # 0 fail
$ yarn workspace cashflow-backend run typecheck   # exit 0
$ yarn workspace cashflow-backend run test        # 4559 tests: 4535 pass, 0 fail, 24 skipped
$ yarn workspace cashflow-backend run build       # exit 0
$ yarn workspace frontend run test                # 218 files, 1225 pass, 0 fail
$ yarn workspace frontend run build               # exit 0
$ yarn workspace frontend run lint                # exit 0
$ yarn workspace frontend run lint:palette        # 377 files clean
```

Design-system rules held: no `@connor-adams/designsystem` component was
restyled — the column captions are plain `<span>`s nested inside `TableHead`,
and `TileCaption` is an app-side Tailwind component. All Tailwind classes are
literal strings.
