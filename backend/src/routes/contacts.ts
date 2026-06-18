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
import { tokenize, suggestSelfContacts } from '../contacts/selfAccountSuggest';

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

    // Load all non-self contacts for this household.
    const contactRows = await Contact.findAll({
      where: { householdId },
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
      where: { ...householdWhere(req), contactId: id },
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
 * Per-person loan ledger (per-person loan ledger feature). Two numbers side by
 * side: raw net transfer flow (auto, over transfers linked via
 * counterparty_contact_id) and tracked-loan outstanding (Reimbursements for
 * this contact). Plus the linked transfer rows, each flagged whether it is
 * already a tracked loan. Per-currency; no FX.
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
    // so raw-net and tracked-outstanding are computed over the same row set.
    const txns = await Transaction.findAll({
      where: { ...householdWhere(req), counterpartyContactId: id },
      attributes: ['id', 'date', 'amount', 'currency', 'merchantClean', 'merchantRaw'],
      order: [['date', 'ASC'], ['id', 'ASC']],
    });
    const reimbs = await Reimbursement.findAll({ where: { ...householdWhere(req), contactId: id } });

    const loanTxnIds = new Set(reimbs.map((r) => r.transactionId));
    // Skip zero-amount rows to match computeTransferNet which also skips them.
    const transfers = txns
      .filter((t) => Number(t.amount) !== 0)
      .map((t) => {
        const amt = Number(t.amount);
        return {
          id: t.id,
          date: t.date,
          amount: String(t.amount),
          currency: t.currency,
          merchant: t.merchantClean ?? t.merchantRaw ?? null,
          direction: amt < 0 ? ('out' as const) : ('in' as const),
          isLoan: loanTxnIds.has(t.id),
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

    res.json({
      contactId: contact.id,
      name: contact.name,
      transferNet,
      trackedOutstandingByCurrency: summary.outstandingByCurrency,
      transfers,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
