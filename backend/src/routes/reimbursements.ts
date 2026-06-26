/**
 * Reimbursement tracker routes (issue #216).
 *
 * Mounted on `/api` so it serves both the per-transaction "mark" shortcut and
 * the top-level `/reimbursements/*` collection:
 *   POST   /api/transactions/:id/reimbursable   — create a claim for an outlay
 *   GET    /api/reimbursements                   — list (filter: status,
 *                                                  contactId, currency,
 *                                                  dueDateFrom/To, overdueOnly,
 *                                                  transactionId)
 *   GET    /api/reimbursements/summary           — outstanding by party+currency
 *   GET    /api/reimbursements/overdue           — overdue queue
 *   GET    /api/reimbursements/:id               — fetch one
 *   PUT    /api/reimbursements/:id               — patch fields
 *   DELETE /api/reimbursements/:id               — delete a claim
 *   GET    /api/reimbursements/:id/match-candidates — likely repayment txns
 *   POST   /api/reimbursements/:id/link-repayment   — link a repayment txn
 *                                                     (marks the claim received)
 *   POST   /api/reimbursements/:id/unlink-repayment — un-link (reopen)
 *
 * Scope: transaction visibility via `visibleTransactionWhere`; the claim
 * collection is household-scoped via the denormalised `household_id` column.
 * All routes are authenticated DB work, so the router carries the shared
 * `aiSuggestLimiter` (no-op in test) per CodeQL's rate-limit guidance.
 */
import { Router, type Request } from 'express';
import {
  Op,
  type WhereOptions,
  type Transaction as DbTransaction,
} from 'sequelize';
import {
  Transaction,
  Reimbursement,
  Contact,
  Account,
  sequelize,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere, householdWhere } from '../auth/scope';
import { resolveHouseholdToday } from '../time/householdToday';
import { aiSuggestLimiter } from './aiRateLimit';
import {
  validateMarkReimbursable,
  validateReimbursementPatch,
  serializeReimbursement,
  summarize,
  resolveToday,
  parseIsoOrNull,
  type ReimbursementRow,
} from '../reimbursements/serialize';
import {
  rankRepaymentCandidates,
  type CandidateTransaction,
} from '../reimbursements/matching';
import { findOrCreateContactByName } from '../contacts/findOrCreateContact';
import {
  REIMBURSEMENT_STATUSES,
  type ReimbursementStatus,
} from '../models/Reimbursement';
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { validateSplitRequest, computeSplitShares } from '../reimbursements/splitShares';

const router = Router();
router.use(aiSuggestLimiter);

// Eager-load shape shared by every read endpoint.
const INCLUDE = [
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
];

function parseLimit(raw: unknown, fallback = 200, max = 500): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Cast an eager-loaded instance into the serializer's row shape. */
function toRow(r: Reimbursement): ReimbursementRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r as unknown as ReimbursementRow;
}

/**
 * Verify a contactId belongs to the caller's household. Returns true when
 * `contactId` is null/undefined (no structured party to check).
 */
async function contactInHousehold(
  req: Request,
  contactId: number | null | undefined,
): Promise<boolean> {
  if (contactId == null) return true;
  const c = await Contact.findOne({
    where: { id: contactId, ...householdWhere(req) },
    attributes: ['id'],
  });
  return Boolean(c);
}

/** True iff every contactId is in the caller's household and none is is_self. */
async function splitContactsOk(
  req: Request,
  contactIds: number[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await Contact.findAll({
    where: { id: contactIds, ...householdWhere(req) },
    attributes: ['id', 'isSelf'],
  });
  if (rows.length !== contactIds.length) {
    return { ok: false, error: 'contactId not found in household' };
  }
  if (rows.some((c) => c.isSelf)) {
    return { ok: false, error: 'cannot split a share to yourself (is_self contact)' };
  }
  return { ok: true };
}

// ----- POST /api/transactions/:id/reimbursable ----------------------------

router.post('/transactions/:id/reimbursable', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (txn.householdId == null) {
      res.status(400).json({ error: 'Transaction has no household' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const v = validateMarkReimbursable(body, {
      txnAmount: txn.amount,
      txnCurrency: txn.currency,
    });
    if (!v.ok) {
      res.status(v.status).json({ error: v.error });
      return;
    }
    if (!(await contactInHousehold(req, v.value.contactId))) {
      res.status(400).json({ error: 'contactId not found in household' });
      return;
    }
    const auth = currentAuth(req);
    const created = await Reimbursement.create({
      householdId: txn.householdId,
      transactionId: txn.id,
      contactId: v.value.contactId ?? null,
      partyName: v.value.partyName ?? null,
      amount: v.value.amount,
      currency: v.value.currency,
      dueDate: v.value.dueDate ?? null,
      status: 'expected',
      repaymentTransactionId: null,
      receivedAt: null,
      createdByUserId: auth.user.id,
      notes: v.value.notes ?? null,
    });
    const reloaded = await Reimbursement.findByPk(created.id, { include: INCLUDE });
    res
      .status(201)
      .json({ data: serializeReimbursement(toRow(reloaded as Reimbursement)) });
  } catch (e) {
    next(e);
  }
});

// ----- POST /api/transactions/:id/reimbursable/promote-counterparty -------
//
// #374: one-click "Promote and use" — given a transaction whose statement-
// import populated `counterparty_raw` but no Contact link (#372), atomically:
//   1. promote the raw text into a Contact (find-or-create in this household
//      by normalized name — same dedup rule as the standalone
//      /counterparty/promote endpoint),
//   2. link `transaction.counterparty_contact_id` to that Contact,
//   3. create the Reimbursement claim using the new contactId (plus any
//      amount / dueDate / notes the user supplied in the body).
// Returns { contact, transaction, reimbursement } so the UI can settle in
// one round-trip.
//
// Rejects when:
//   - counterpartyRaw is missing (nothing to promote → use the regular
//     /reimbursable endpoint with partyName instead)
//   - counterpartyContactId is already populated (the regular /reimbursable
//     endpoint with contactId pre-fill is the right path — see AC#1).

router.post(
  '/transactions/:id/reimbursable/promote-counterparty',
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }
      const txn = await Transaction.findOne({
        where: { id, ...visibleTransactionWhere(req) },
      });
      if (!txn) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (txn.householdId == null) {
        res.status(400).json({ error: 'Transaction has no household' });
        return;
      }
      if (txn.counterpartyContactId != null) {
        res.status(400).json({
          error:
            'Transaction is already linked to a Contact; use /reimbursable with contactId',
        });
        return;
      }
      const rawName = (txn.counterpartyRaw ?? '').trim();
      if (!rawName) {
        res.status(400).json({
          error:
            'Transaction has no counterpartyRaw to promote; use /reimbursable with partyName',
        });
        return;
      }
      const auth = currentAuth(req);
      const body = (req.body || {}) as Record<string, unknown>;
      // Pre-validate the reimbursement body. We force the contactId to the
      // promoted contact below, so strip any caller-supplied contactId/partyName
      // from the validation surface — promotion supplies the party.
      const validationBody: Record<string, unknown> = { ...body, contactId: 1 };
      delete validationBody.partyName;
      const v = validateMarkReimbursable(validationBody, {
        txnAmount: txn.amount,
        txnCurrency: txn.currency,
      });
      if (!v.ok) {
        res.status(v.status).json({ error: v.error });
        return;
      }

      const result = await sequelize.transaction(async (t) => {
        // Find-or-create dedup, scoped to (householdId, normalized_name) —
        // same rule as the standalone /counterparty/promote endpoint on the
        // transactions route, so a user who promotes via either path lands on
        // the same Contact row.
        const contact = await findOrCreateContactByName(txn.householdId!, rawName, { transaction: t });
        txn.counterpartyContactId = contact.id;
        await txn.save({ transaction: t });
        const claim = await Reimbursement.create(
          {
            householdId: txn.householdId!,
            transactionId: txn.id,
            contactId: contact.id,
            partyName: null,
            amount: v.value.amount,
            currency: v.value.currency,
            dueDate: v.value.dueDate ?? null,
            status: 'expected',
            repaymentTransactionId: null,
            receivedAt: null,
            createdByUserId: auth.user.id,
            notes: v.value.notes ?? null,
          },
          { transaction: t },
        );
        return { contact, claimId: claim.id };
      });

      const reloaded = await Reimbursement.findByPk(result.claimId, {
        include: INCLUDE,
      });
      res.status(201).json({
        contact: result.contact,
        transaction: { id: txn.id, counterpartyContactId: result.contact.id },
        reimbursement: serializeReimbursement(toRow(reloaded as Reimbursement)),
      });
    } catch (e) {
      next(e);
    }
  },
);

// ----- POST /api/transactions/:id/split -----------------------------------
// Multiway split: payer fronts the outlay, each other participant owes a share
// back (one Reimbursement per participant, from_split=true). Replaces any prior
// from_split claims on this txn. Sets the txn to ownership 'me' so it leaves the
// partner-fairness shared pool (no double-count of a partner participant).
router.post('/transactions/:id/split', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) } });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (txn.householdId == null) {
      res.status(400).json({ error: 'Transaction has no household' });
      return;
    }
    const v = validateSplitRequest((req.body || {}) as Record<string, unknown>);
    if (!v.ok) {
      res.status(v.status).json({ error: v.error });
      return;
    }
    const ids = v.value.participants.map((p) => p.contactId);
    const contactsOk = await splitContactsOk(req, ids);
    if (!contactsOk.ok) {
      res.status(400).json({ error: contactsOk.error });
      return;
    }
    const auth = currentAuth(req);
    const { shares } = computeSplitShares(
      txn.amount,
      v.value.method,
      v.value.participants,
      v.value.includeSelf,
    );
    await sequelize.transaction(async (t) => {
      // Preserve received or repayment-linked split claims — only remove still-open ones.
      await Reimbursement.destroy({
        where: {
          transactionId: txn.id,
          fromSplit: true,
          status: { [Op.ne]: 'received' },
          repaymentTransactionId: null,
        },
        transaction: t,
      });
      await Reimbursement.bulkCreate(
        shares.map((s) => ({
          householdId: txn.householdId!,
          transactionId: txn.id,
          contactId: s.contactId,
          partyName: null,
          amount: s.amount,
          currency: txn.currency,
          dueDate: null,
          status: 'expected' as const,
          repaymentTransactionId: null,
          receivedAt: null,
          createdByUserId: auth.user.id,
          notes: `Multiway split (${v.value.method})`,
          fromSplit: true,
        })),
        { transaction: t },
      );
      txn.ownershipType = 'me';
      txn.splitOverride = 'me';
      recomputeTransactionAmounts(txn);
      await txn.save({ transaction: t });
    });
    const claims = await Reimbursement.findAll({
      where: { transactionId: txn.id, fromSplit: true },
      include: INCLUDE,
      order: [['id', 'ASC']],
    });
    res.status(201).json({
      transaction: { id: txn.id, ownershipType: txn.ownershipType, finalSplitType: txn.finalSplitType },
      claims: claims.map((r) => serializeReimbursement(toRow(r))),
    });
  } catch (e) {
    next(e);
  }
});

// ----- DELETE /api/transactions/:id/split ---------------------------------
router.delete('/transactions/:id/split', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) } });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (txn.householdId == null) {
      res.status(400).json({ error: 'Transaction has no household' });
      return;
    }
    await sequelize.transaction(async (t) => {
      // Preserve received or repayment-linked split claims — only remove still-open ones.
      await Reimbursement.destroy({
        where: {
          transactionId: txn.id,
          fromSplit: true,
          status: { [Op.ne]: 'received' },
          repaymentTransactionId: null,
        },
        transaction: t,
      });
      txn.ownershipType = 'me';
      txn.splitOverride = 'me';
      recomputeTransactionAmounts(txn);
      await txn.save({ transaction: t });
    });
    res.status(200).json({
      transaction: { id: txn.id, ownershipType: txn.ownershipType, finalSplitType: txn.finalSplitType },
      claims: [],
    });
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/reimbursements --------------------------------------------

router.get('/reimbursements', async (req, res, next) => {
  try {
    currentAuth(req);
    // `today` may be the browser's local date so overdue derivation flips at
    // the user's midnight rather than UTC's (which is hours early in the
    // Americas). Invalid/missing values fall back to UTC today.
    const today = resolveToday(
      req.query.today,
      resolveHouseholdToday(currentAuth(req).household),
    );
    const where: WhereOptions = { ...householdWhere(req) };
    const q = req.query;

    if (typeof q.status === 'string' && q.status) {
      if ((REIMBURSEMENT_STATUSES as readonly string[]).includes(q.status)) {
        (where as Record<string, unknown>).status = q.status;
      } else {
        res.status(400).json({
          error: `status must be one of: ${REIMBURSEMENT_STATUSES.join(', ')}`,
        });
        return;
      }
    }
    if (q.contactId) {
      const n = Number(q.contactId);
      if (Number.isInteger(n) && n > 0) {
        (where as Record<string, unknown>).contactId = n;
      }
    }
    if (typeof q.currency === 'string' && q.currency) {
      (where as Record<string, unknown>).currency = q.currency
        .toUpperCase()
        .slice(0, 3);
    }
    if (q.transactionId) {
      const n = Number(q.transactionId);
      if (Number.isInteger(n) && n > 0) {
        (where as Record<string, unknown>).transactionId = n;
      }
    }
    const from = parseIsoOrNull(q.dueDateFrom);
    const to = parseIsoOrNull(q.dueDateTo);
    if (from || to) {
      const cond: { [Op.gte]?: string; [Op.lte]?: string } = {};
      if (from) cond[Op.gte] = from;
      if (to) cond[Op.lte] = to;
      (where as Record<string, unknown>).dueDate = cond;
    }

    const rows = await Reimbursement.findAll({
      where,
      include: INCLUDE,
      order: [
        ['due_date', 'ASC'],
        ['created_at', 'DESC'],
      ],
      limit: parseLimit(q.limit),
    });
    let data = rows.map((r) => serializeReimbursement(toRow(r), today));
    // overdueOnly is a derived filter, applied after effective-status compute.
    if (q.overdueOnly === 'true' || q.overdueOnly === '1') {
      data = data.filter((d) => d.isOverdue);
    }
    res.json({ data, count: data.length, today });
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/reimbursements/summary ------------------------------------

router.get('/reimbursements/summary', async (req, res, next) => {
  try {
    currentAuth(req);
    const today = resolveToday(
      req.query.today,
      resolveHouseholdToday(currentAuth(req).household),
    );
    // Full INCLUDE (not just contact): summarize() nets a received claim
    // against its hydrated same-currency repayment transaction so a partial
    // repayment doesn't credit the full claim face value.
    const rows = await Reimbursement.findAll({
      where: { ...householdWhere(req) },
      include: INCLUDE,
    });
    const summary = summarize(rows.map(toRow), today);
    res.json({ ...summary, today });
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/reimbursements/overdue ------------------------------------

router.get('/reimbursements/overdue', async (req, res, next) => {
  try {
    currentAuth(req);
    const today = resolveToday(
      req.query.today,
      resolveHouseholdToday(currentAuth(req).household),
    );
    // Candidates: open claims with a due date strictly before today, OR claims
    // explicitly pinned to the 'overdue' status.
    const rows = await Reimbursement.findAll({
      where: {
        ...householdWhere(req),
        [Op.or]: [
          { status: 'expected', dueDate: { [Op.lt]: today } },
          { status: 'overdue' },
        ],
      } as WhereOptions,
      include: INCLUDE,
      order: [['due_date', 'ASC']],
      limit: parseLimit(req.query.limit),
    });
    const data = rows
      .map((r) => serializeReimbursement(toRow(r), today))
      .filter((d) => d.effectiveStatus === 'overdue');
    res.json({ data, count: data.length, today });
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/reimbursements/:id ----------------------------------------

router.get('/reimbursements/:id', async (req, res, next) => {
  try {
    currentAuth(req);
    const r = await loadOwned(req);
    if (!r) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ data: serializeReimbursement(toRow(r)) });
  } catch (e) {
    next(e);
  }
});

// ----- PUT /api/reimbursements/:id ----------------------------------------

router.put('/reimbursements/:id', async (req, res, next) => {
  try {
    currentAuth(req);
    const patch = validateReimbursementPatch(
      (req.body || {}) as Record<string, unknown>,
    );
    if (!patch.ok) {
      res.status(patch.status).json({ error: patch.error });
      return;
    }
    // Validate the contact (a household-scoped read) BEFORE opening the write
    // transaction so we don't hold a row lock across an unrelated query.
    if ('contactId' in patch.value) {
      if (!(await contactInHousehold(req, patch.value.contactId))) {
        res.status(400).json({ error: 'contactId not found in household' });
        return;
      }
    }

    // Lock the row, then apply ONLY the patched fields. The previous code did a
    // blind full-instance save() of a separately-loaded instance, so two
    // concurrent PUTs (e.g. {amount} vs {status:received}) clobbered each
    // other's untouched fields. Loading under LOCK.UPDATE inside the tx
    // serializes the read-modify-write (issue #846).
    const out = await sequelize.transaction(async (t) => {
      const r = await loadOwnedForUpdate(req, t);
      if (!r) return { ok: false as const };
      if ('contactId' in patch.value) r.contactId = patch.value.contactId ?? null;
      if ('partyName' in patch.value) r.partyName = patch.value.partyName ?? null;
      if ('amount' in patch.value && patch.value.amount) r.amount = patch.value.amount;
      if ('currency' in patch.value && patch.value.currency) {
        r.currency = patch.value.currency;
      }
      if ('dueDate' in patch.value) r.dueDate = patch.value.dueDate ?? null;
      if ('notes' in patch.value) r.notes = patch.value.notes ?? null;
      if ('status' in patch.value && patch.value.status) {
        applyStatus(r, patch.value.status);
      }
      await r.save({ transaction: t });
      return { ok: true as const, id: r.id };
    });

    if (!out.ok) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const reloaded = await Reimbursement.findByPk(out.id, { include: INCLUDE });
    res.json({ data: serializeReimbursement(toRow(reloaded as Reimbursement)) });
  } catch (e) {
    next(e);
  }
});

// ----- DELETE /api/reimbursements/:id -------------------------------------

router.delete('/reimbursements/:id', async (req, res, next) => {
  try {
    currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const deleted = await Reimbursement.destroy({
      where: { id, ...householdWhere(req) },
    });
    if (deleted === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// ----- GET /api/reimbursements/:id/match-candidates -----------------------

router.get('/reimbursements/:id/match-candidates', async (req, res, next) => {
  try {
    currentAuth(req);
    const r = await loadOwned(req);
    if (!r) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const outlay = await Transaction.findByPk(r.transactionId, {
      attributes: ['id', 'date'],
    });
    if (!outlay) {
      res.json({ data: [], count: 0 });
      return;
    }
    const limit = parseLimit(req.query.limit, 5, 25);
    // Pull visible inflows in the same currency on/after the outlay, excluding
    // the outlay itself and any already-linked repayment. Over-fetch then rank.
    const candidates = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        currency: r.currency,
        amount: { [Op.gt]: 0 },
        date: { [Op.gte]: outlay.date },
        id: { [Op.ne]: r.transactionId },
      } as WhereOptions,
      attributes: ['id', 'date', 'merchantClean', 'amount', 'currency'],
      include: [
        { model: Account, as: 'account', attributes: ['id', 'name'], required: false },
      ],
      order: [['date', 'ASC']],
      limit: 500,
    });
    const candInputs: CandidateTransaction[] = candidates.map((c) => ({
      id: c.id,
      amount: c.amount,
      currency: c.currency,
      date: c.date,
      merchantClean: c.merchantClean,
    }));
    const ranked = rankRepaymentCandidates(
      {
        amount: r.amount,
        currency: r.currency,
        outlayDate: outlay.date,
        dueDate: r.dueDate,
      },
      candInputs,
      limit,
    );
    res.json({ data: ranked, count: ranked.length });
  } catch (e) {
    next(e);
  }
});

// ----- POST /api/reimbursements/:id/link-repayment ------------------------

router.post('/reimbursements/:id/link-repayment', async (req, res, next) => {
  try {
    currentAuth(req);
    const body = (req.body || {}) as Record<string, unknown>;
    const txnId = Number(body.transactionId);
    if (!Number.isInteger(txnId) || txnId <= 0) {
      res.status(400).json({ error: 'transactionId is required' });
      return;
    }
    const repayment = await Transaction.findOne({
      where: { id: txnId, ...visibleTransactionWhere(req) },
      attributes: ['id', 'amount', 'currency'],
    });
    if (!repayment) {
      res.status(404).json({ error: 'Repayment transaction not found' });
      return;
    }
    // Mirror the match-candidates eligibility filter: a repayment must be an
    // inflow (positive) in the claim's currency. Without this, linking an
    // arbitrary visible transaction silently marks the claim received.
    if (!(Number(repayment.amount) > 0)) {
      res.status(400).json({ error: 'Repayment must be a positive inflow' });
      return;
    }
    // Lock the claim, verify currency against the LOCKED row, then take the
    // repayment with a conditional UPDATE that only succeeds if no other claim
    // already holds it. This + the partial-unique index on
    // repayment_transaction_id stops the double-credit race where the same
    // inflow closes two claims (issue #846).
    const out = await sequelize.transaction(async (t) => {
      const r = await loadOwnedForUpdate(req, t);
      if (!r) return { kind: 'not-found' as const };
      if (repayment.currency !== r.currency) {
        return { kind: 'currency-mismatch' as const, expected: r.currency };
      }
      if (r.repaymentTransactionId === repayment.id) {
        // Idempotent re-link of the same repayment to the same claim.
        return { kind: 'ok' as const, id: r.id };
      }
      // Guard: the target repayment must not already be claimed by another
      // (non-this) row. SELECT under the same tx; the partial-unique index is
      // the backstop if a racer slips between this read and our UPDATE.
      const claimedElsewhere = await Reimbursement.findOne({
        where: {
          repaymentTransactionId: repayment.id,
          ...householdWhere(req),
          id: { [Op.ne]: r.id },
        },
        attributes: ['id'],
        transaction: t,
      });
      if (claimedElsewhere) {
        return { kind: 'conflict' as const };
      }
      r.repaymentTransactionId = repayment.id;
      // Linking a repayment closes the claim as received (unless explicitly
      // waived already — keep waived as a terminal user choice).
      if (r.status !== 'waived') {
        r.status = 'received';
        r.receivedAt = new Date();
      }
      await r.save({ transaction: t });
      return { kind: 'ok' as const, id: r.id };
    });

    if (out.kind === 'not-found') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (out.kind === 'currency-mismatch') {
      res.status(400).json({
        error: `Repayment currency must match the claim (${out.expected})`,
      });
      return;
    }
    if (out.kind === 'conflict') {
      res.status(409).json({
        error: 'Repayment transaction is already linked to another claim',
      });
      return;
    }
    const reloaded = await Reimbursement.findByPk(out.id, { include: INCLUDE });
    res.json({ data: serializeReimbursement(toRow(reloaded as Reimbursement)) });
  } catch (e) {
    // The partial-unique index is the last-line backstop: if two requests race
    // past the in-tx guard, the DB rejects the second with a unique violation.
    // Translate that to the same 409 the guard returns.
    if (isUniqueRepaymentViolation(e)) {
      res
        .status(409)
        .json({ error: 'Repayment transaction is already linked to another claim' });
      return;
    }
    next(e);
  }
});

// ----- POST /api/reimbursements/:id/unlink-repayment ----------------------

router.post('/reimbursements/:id/unlink-repayment', async (req, res, next) => {
  try {
    currentAuth(req);
    // Lock + mutate inside the tx so an interleaved link/unlink can't leave the
    // claim in a torn state (status=received but link=null, or vice versa).
    const out = await sequelize.transaction(async (t) => {
      const r = await loadOwnedForUpdate(req, t);
      if (!r) return { ok: false as const };
      r.repaymentTransactionId = null;
      // Reopen a received claim; leave waived/overdue pins as-is.
      if (r.status === 'received') {
        r.status = 'expected';
        r.receivedAt = null;
      }
      await r.save({ transaction: t });
      return { ok: true as const, id: r.id };
    });
    if (!out.ok) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const reloaded = await Reimbursement.findByPk(out.id, { include: INCLUDE });
    res.json({ data: serializeReimbursement(toRow(reloaded as Reimbursement)) });
  } catch (e) {
    next(e);
  }
});

// ----- helpers ------------------------------------------------------------

async function loadOwned(req: Request): Promise<Reimbursement | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return Reimbursement.findOne({
    where: { id, ...householdWhere(req) },
    include: INCLUDE,
  });
}

/**
 * Load the household-scoped claim inside an open transaction WITH a row lock
 * (SELECT ... FOR UPDATE on Postgres). Used by the mutating handlers so a
 * concurrent writer blocks until we commit, closing the read-modify-write race
 * (issue #846). No `include` here: eager-loaded JOINs can't be row-locked
 * portably, and the locked row is all the guard logic needs — we re-fetch the
 * hydrated row for the response after commit.
 */
async function loadOwnedForUpdate(
  req: Request,
  t: DbTransaction,
): Promise<Reimbursement | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return Reimbursement.findOne({
    where: { id, ...householdWhere(req) },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}

/**
 * True iff `e` is a unique-constraint violation on the partial-unique
 * `repayment_transaction_id` index (migration 20260626000001). Cross-dialect:
 * SQLite reports "SQLITE_CONSTRAINT", Postgres "23505"; Sequelize wraps both as
 * SequelizeUniqueConstraintError. We narrow to the repayment index so an
 * unrelated unique violation isn't masked as a 409 — falling back to the
 * generic name check only when no index/field detail is available.
 */
function isUniqueRepaymentViolation(e: unknown): boolean {
  const err = e as {
    name?: string;
    fields?: Record<string, unknown> | string[];
    original?: { code?: string; constraint?: string };
    parent?: { code?: string; constraint?: string };
  };
  const code = err?.original?.code ?? err?.parent?.code;
  const isUnique =
    err?.name === 'SequelizeUniqueConstraintError' ||
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT';
  if (!isUnique) return false;
  const constraint = err?.original?.constraint ?? err?.parent?.constraint ?? '';
  const fields = Array.isArray(err?.fields)
    ? err.fields.join(',')
    : Object.keys(err?.fields ?? {}).join(',');
  const detail = `${constraint} ${fields}`;
  // When the dialect tells us which index/field tripped, require it to be the
  // repayment one; otherwise (no detail) trust the unique signal.
  return detail.trim() === '' || /repayment_transaction_id/.test(detail);
}

/**
 * Apply a status transition, keeping `receivedAt` consistent: setting
 * `received` stamps the time (if not already), moving away from `received`
 * clears it.
 */
function applyStatus(r: Reimbursement, status: ReimbursementStatus): void {
  const wasReceived = r.status === 'received';
  r.status = status;
  if (status === 'received') {
    if (!r.receivedAt) r.receivedAt = new Date();
  } else if (wasReceived) {
    r.receivedAt = null;
  }
}

export default router;
