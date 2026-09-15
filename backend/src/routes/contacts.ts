import { Router } from 'express';
import { Account, Contact, Reimbursement, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { resolveHouseholdToday } from '../time/householdToday';
import { apiReadLimiter } from './apiRateLimit';
import { findOrCreateContactByName } from '../contacts/findOrCreateContact';
import {
  summarizeOpenForContact,
  summarize,
  resolveToday,
  type ReimbursementRow,
} from '../reimbursements/serialize';
import { computeTransferNet, type TransferRow } from '../contacts/transferLedger';
import { computeLoanBalance } from '../contacts/loanBalance';
import { resolveLedgerRole } from '../contacts/counterpartyRole';
import { findCancelledTransferIds } from '../contacts/cancelPairing';
import { tokenize, suggestSelfContacts } from '../contacts/selfAccountSuggest';
import {
  runInterestAllocation,
  loadInterestContext,
  computeCharged,
  estimateAccrued,
  isInterestAllocationRunning,
  sumFixed4,
  INTEREST_KIND,
  PRINCIPAL_KIND,
} from '../contacts/runInterestAllocation';
import type { ContactLedgerResponse, LoanBalance } from '@cashflow/shared';

/**
 * Fold per-currency interest amounts into the `LoanBalance` shape the principal
 * figure already uses, so a page can render all three tiles identically.
 *
 * `repaid` is always zero. An allocated interest row is not repaid piecemeal the
 * way a loan is — it is recomputed wholesale on the next allocator run — so
 * there is no repayment leg to report, and reporting one would invent a fact.
 */
function toInterestBalances(rows: Array<{ currency: string; amount: string | number }>): LoanBalance[] {
  const byCurrency = new Map<string, Array<string | number>>();
  for (const r of rows) {
    const list = byCurrency.get(r.currency);
    if (list) list.push(r.amount);
    else byCurrency.set(r.currency, [r.amount]);
  }
  return [...byCurrency.keys()].sort().map((currency) => {
    const total = sumFixed4(byCurrency.get(currency) ?? []);
    return { currency, lent: total, repaid: '0.0000', balance: total };
  });
}

/**
 * The latest `YYYY-MM-DD` in a list, or `null` when there is none.
 *
 * `null` in, `null` out: an absent date is not "the beginning of time", and a
 * coverage claim built on a blank is exactly what this ledger must never make.
 * Plain string comparison is correct for zero-padded ISO dates.
 */
function latestDate(dates: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const d of dates) {
    if (typeof d !== 'string' || d === '') continue;
    if (latest === null || d > latest) latest = d;
  }
  return latest;
}

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const rows = await Contact.findAll({
      where: householdWhere(req),
      order: [['name', 'ASC']],
    });
    // Include isSelf so the frontend can section self-accounts separately.
    res.json(rows.map((r) => ({
      id: r.id,
      householdId: r.householdId,
      name: r.name,
      notes: r.notes,
      isPartner: r.isPartner,
      isSelf: r.isSelf,
      aliases: r.aliases,
      normalizedName: r.normalizedName,
      loanDefault: r.loanDefault,
    })));
  } catch (e) {
    next(e);
  }
});

/**
 * Self-account auto-suggest. Returns contacts whose name tokens overlap the
 * current user's name tokens or any household account name tokens. The user
 * then confirms via PATCH /:id { isSelf: true }, after which the contact is
 * excluded from the transfer-link pass permanently.
 *
 * MOUNT ORDER: this literal path MUST stay above the `/:id` param route so
 * Express matches "self-suggestions" as a path segment, not as an :id value.
 */
router.get('/self-suggestions', apiReadLimiter, async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const householdId = household.id;

    // Load non-self contacts for this household — already-flagged self
    // accounts are filtered at the DB so we never re-suggest them.
    const contactRows = await Contact.findAll({
      where: { householdId, isSelf: false },
      order: [['name', 'ASC']],
    });

    // Tokenize the current user's display name.
    const userNameTokens = tokenize(user.displayName ?? '');

    // Tokenize all household account names.
    const accountRows = await Account.findAll({
      where: { householdId },
      attributes: ['name'],
    });
    const accountNameTokens = accountRows.flatMap((a) => tokenize(a.name));

    const suggestions = suggestSelfContacts(
      contactRows.map((c) => ({
        id: c.id,
        name: c.name,
        normalizedName: c.normalizedName ?? null,
        isSelf: c.isSelf ?? false,
      })),
      userNameTokens,
      accountNameTokens,
    );

    res.json({ suggestions });
  } catch (e) {
    next(e);
  }
});

/**
 * #374 — Contact detail. Returns the Contact plus an `openReimbursements`
 * aggregate so the UI can render "Open reimbursements: $X across Y items" and
 * the per-item list without a second round-trip. Only effectively-open claims
 * (`expected` or derived-overdue) count toward the aggregate; received and
 * waived are excluded by `summarizeOpenForContact`.
 *
 * Each item in `openReimbursements.items` is a fully-serialized
 * `ReimbursementView` so the frontend reuses the same shape it already
 * renders on /reimbursements.
 */
router.get('/:id', apiReadLimiter, async (req, res, next) => {
  try {
    currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const contact = await Contact.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!contact) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Browser-local date override so open/overdue derivation matches the
    // user's calendar day; falls back to the household-zone today.
    const today = resolveToday(
      req.query.today,
      resolveHouseholdToday(currentAuth(req).household),
    );
    const rows = await Reimbursement.findAll({
      // Principal only. `kind='interest'` rows are generated by the LoC interest
      // allocator, not hand-logged claims; surfacing them here would double-count
      // interest into the open-reimbursement aggregate.
      where: { ...householdWhere(req), contactId: id, kind: PRINCIPAL_KIND },
      include: [
        { model: Contact, as: 'contact', attributes: ['id', 'name'], required: false },
        {
          model: Transaction,
          as: 'transaction',
          attributes: ['id', 'date', 'merchantClean', 'amount', 'currency'],
          required: false,
        },
        {
          model: Transaction,
          as: 'repaymentTransaction',
          attributes: ['id', 'date', 'merchantClean', 'amount', 'currency'],
          required: false,
        },
      ],
      order: [
        ['due_date', 'ASC'],
        ['created_at', 'DESC'],
      ],
    });
    const open = summarizeOpenForContact(
      rows.map((r) => r as unknown as ReimbursementRow),
      today,
    );
    res.json({
      id: contact.id,
      householdId: contact.householdId,
      name: contact.name,
      notes: contact.notes,
      isPartner: contact.isPartner,
      isSelf: contact.isSelf,
      aliases: contact.aliases,
      openReimbursements: open,
      today,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * #375 — coerce common boolean representations from a JSON body so the
 * `is_partner` flag can be set from a checkbox (true/false), an HTML form
 * (the strings "true"/"false"), or a 0/1 integer. Returns null for invalid
 * input so the route can 400.
 */
function coerceBool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === 'false' || raw === 0 || raw === '0') return false;
  return null;
}

router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const b = (req.body || {}) as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    let isPartner = false;
    if (b.isPartner !== undefined) {
      const parsed = coerceBool(b.isPartner);
      if (parsed === null) {
        res.status(400).json({ error: 'isPartner must be boolean' });
        return;
      }
      isPartner = parsed;
    }
    const row = await findOrCreateContactByName(household.id, name);
    let changed = false;
    if (b.notes != null) { row.set('notes', String(b.notes)); changed = true; }
    if (b.aliases != null) { row.set('aliases', String(b.aliases).slice(0, 500)); changed = true; }
    if (isPartner) { row.set('isPartner', true); changed = true; }
    if (changed) await row.save();
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Contact.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) {
        res.status(400).json({ error: 'name cannot be empty' });
        return;
      }
      row.set('name', name);
    }
    if (b.notes !== undefined) row.set('notes', b.notes != null ? String(b.notes) : null);
    if (b.aliases !== undefined) {
      row.set('aliases', b.aliases != null ? String(b.aliases).slice(0, 500) : null);
    }
    if (b.isPartner !== undefined) {
      const parsed = coerceBool(b.isPartner);
      if (parsed === null) {
        res.status(400).json({ error: 'isPartner must be boolean' });
        return;
      }
      row.set('isPartner', parsed);
    }
    if (b.isSelf !== undefined) {
      const parsed = coerceBool(b.isSelf);
      if (parsed === null) {
        res.status(400).json({ error: 'isSelf must be boolean' });
        return;
      }
      row.set('isSelf', parsed);
    }
    if (b.loanDefault !== undefined) {
      const parsed = coerceBool(b.loanDefault);
      if (parsed === null) {
        res.status(400).json({ error: 'loanDefault must be boolean' });
        return;
      }
      row.set('loanDefault', parsed);
    }
    await row.save();
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Contact.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

/**
 * Per-person loan ledger (per-person loan ledger feature). Three numbers, all
 * per-currency and FX-free, over transfers linked via counterparty_contact_id:
 *
 *   - `loanBalance` — the signed debt, and the ONLY number that means "owes
 *     you". Folded from each row's counterparty_role (with the contact's
 *     loanDefault standing in for untagged rows), so purchases, business flows
 *     and gifts contribute nothing.
 *   - `transferNet` — raw money in/out. Descriptive only; it used to be served
 *     as the amount owed, which reported ~79k of non-debt across four contacts.
 *   - `trackedOutstandingByCurrency` — the Reimbursements for this contact.
 *
 * Plus every linked transfer row, each carrying how it landed in the balance
 * (`ledgerEffect`), whether its tag fought its direction (`roleMismatch`),
 * whether it is a cancelled e-transfer leg (`cancelled`), and whether it is
 * already a tracked loan (`isLoan`).
 */
router.get('/:id/ledger', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const contact = await Contact.findOne({ where: { id, ...householdWhere(req) } });
    if (!contact) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Ledger is household-scoped to match the link pass and tracked-loan balance,
    // so raw-net and loan balance are computed over the same row set.
    const txnsRaw = await Transaction.findAll({
      where: { ...householdWhere(req), counterpartyContactId: id },
      attributes: [
        'id', 'date', 'amount', 'currency',
        'merchantClean', 'merchantRaw', 'counterpartyRole',
      ],
      order: [['date', 'ASC'], ['id', 'ASC']],
    });

    // Cancelled e-transfer pairs drop out entirely: the reversal is not a
    // repayment, and the original never moved money.
    const cancelled = findCancelledTransferIds(
      txnsRaw.map((t) => ({ id: t.id, merchantText: t.merchantRaw ?? t.merchantClean ?? null })),
    );
    const txns = txnsRaw.filter((t) => !cancelled.has(t.id));

    const loanDefault = contact.loanDefault ?? false;
    const balanceRows = txns.map((t) => ({
      amount: t.amount,
      currency: t.currency,
      counterpartyRole: t.counterpartyRole ?? null,
    }));
    const loanBalance = computeLoanBalance(balanceRows, loanDefault);

    // Principal claims and generated interest rows are read separately and never
    // summed: `trackedOutstandingByCurrency` counts hand-logged claims only.
    const reimbs = await Reimbursement.findAll({
      where: { ...householdWhere(req), contactId: id, kind: PRINCIPAL_KIND },
    });
    const loanTxnIds = new Set(reimbs.map((r) => r.transactionId));
    const interestRows = await Reimbursement.findAll({
      where: { ...householdWhere(req), contactId: id, kind: INTEREST_KIND },
      attributes: ['currency', 'amount'],
    });
    const interestCharged = toInterestBalances(interestRows);

    // Every linked row is listed, cancelled ones included, so the user can see
    // why a pair contributed nothing rather than wondering where it went.
    const transfers = txnsRaw.map((t) => {
      const amt = Number(t.amount);
      const { effect, mismatch } = resolveLedgerRole({
        role: t.counterpartyRole ?? null,
        amount: amt,
        loanDefault,
      });
      const isCancelled = cancelled.has(t.id);
      return {
        id: t.id,
        date: t.date,
        // DECIMAL(14,4) round-trips as a string on Postgres and a JS number on
        // SQLite; toFixed(4) makes the DTO dialect-independent.
        amount: Number(t.amount).toFixed(4),
        currency: t.currency,
        // Raw text: merchantClean strips the counterparty name off RBC transfers,
        // which is what made 157 Stephen rows indistinguishable.
        merchant: t.merchantRaw ?? t.merchantClean ?? null,
        direction: amt < 0 ? ('out' as const) : ('in' as const),
        isLoan: loanTxnIds.has(t.id),
        counterpartyRole: (t.counterpartyRole ?? null) as ContactLedgerResponse['transfers'][number]['counterpartyRole'],
        ledgerEffect: isCancelled ? ('none' as const) : effect,
        roleMismatch: isCancelled ? false : mismatch,
        cancelled: isCancelled,
      };
    });

    const transferNet = computeTransferNet(
      txns.map((t) => ({ amount: t.amount, currency: t.currency }) as TransferRow),
    );
    const today = resolveToday(
      req.query.today,
      resolveHouseholdToday(currentAuth(req).household),
    );
    const summary = summarize(reimbs.map((r) => r as unknown as ReimbursementRow), today);

    // The accrued tail and the per-window scaling factors are DERIVED on every
    // read. The tail changes daily, so persisting it would make yesterday's
    // estimate look like a billed fact; the factors are a diagnostic over the
    // same recomputation, not a second source of truth.
    const interestCtx = await loadInterestContext(currentAuth(req).household.id);
    const interestAccrued = toInterestBalances(
      estimateAccrued(interestCtx, today).filter((a) => a.contactId === id),
    );
    const recomputed = computeCharged(interestCtx);
    const interestWindows = recomputed.windows;

    // `interestCharged` above is the PERSISTED rows; `interestWindows` is this
    // fresh recomputation. Nothing runs the allocator automatically, so after a
    // statement import the two disagree until someone presses the button — and a
    // caption drawn from the live windows would then name a statement the stored
    // figure does not cover. `computeCharged` is already being called, so the
    // comparison costs nothing and is served rather than left to the UI to guess.
    const householdInterestRows = await Reimbursement.findAll({
      where: { ...householdWhere(req), kind: INTEREST_KIND },
      attributes: ['amount', 'dueDate'],
    });
    const persistedTotal = sumFixed4(householdInterestRows.map((r) => r.amount));
    const recomputedTotal = sumFixed4(recomputed.allocations.map((a) => a.amount));
    // A persisted row's `dueDate` is its window's last day (see
    // runInterestAllocation), so the latest one is what the stored figure covers.
    const chargedThrough = latestDate(
      householdInterestRows.map((r) => (r.dueDate == null ? null : String(r.dueDate).slice(0, 10))),
    );
    const statementThrough = latestDate(
      interestCtx.accounts.flatMap((a) => a.windows.map((w) => w.toDate)),
    );
    const interestStaleness: ContactLedgerResponse['interestStaleness'] = {
      // Totals, not dates: a newly imported window that allocates nothing leaves
      // the stored figure genuinely complete, and flagging it stale would cry
      // wolf. Any window that WOULD allocate moves the total.
      stale: persistedTotal !== recomputedTotal,
      persistedTotal,
      recomputedTotal,
      chargedThrough,
      statementThrough,
    };

    res.json({
      contactId: contact.id,
      name: contact.name,
      loanDefault,
      transferNet,
      loanBalance,
      interestCharged,
      interestAccrued,
      interestWindows,
      interestStaleness,
      trackedOutstandingByCurrency: summary.outstandingByCurrency,
      transfers,
    } satisfies ContactLedgerResponse);
  } catch (e) {
    next(e);
  }
});

/**
 * Recompute the line-of-credit interest allocation for the household.
 *
 * Charged rows are deleted and re-inserted, so re-running recomputes rather than
 * accumulating. The accrued estimate is NOT touched — it has no rows, by design.
 *
 * MOUNT ORDER: this literal path sits above nothing that would shadow it (there
 * is no `POST /:id`), but it is declared beside the other literal routes so a
 * future `POST /:id` cannot silently capture it.
 */
router.post('/interest-allocation', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const b = (req.body || {}) as Record<string, unknown>;
    const dryRun = b.dryRun === true || b.dryRun === 'true';
    const accountIdRaw = b.accountId === undefined ? undefined : Number(b.accountId);
    if (accountIdRaw !== undefined && (!Number.isInteger(accountIdRaw) || accountIdRaw <= 0)) {
      res.status(400).json({ error: 'accountId must be a positive integer' });
      return;
    }
    if (isInterestAllocationRunning(household.id)) {
      res.status(409).json({ error: 'interest allocation already running' });
      return;
    }
    const result = await runInterestAllocation({
      householdId: household.id,
      accountId: accountIdRaw,
      asOf: typeof b.asOf === 'string' ? b.asOf : undefined,
      dryRun,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
