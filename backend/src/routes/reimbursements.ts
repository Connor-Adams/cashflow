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
import { Op, type WhereOptions } from 'sequelize';
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
    const r = await loadOwned(req);
    if (!r) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const patch = validateReimbursementPatch(
      (req.body || {}) as Record<string, unknown>,
    );
    if (!patch.ok) {
      res.status(patch.status).json({ error: patch.error });
      return;
    }
    if ('contactId' in patch.value) {
      if (!(await contactInHousehold(req, patch.value.contactId))) {
        res.status(400).json({ error: 'contactId not found in household' });
        return;
      }
      r.contactId = patch.value.contactId ?? null;
    }
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
    await r.save();
    const reloaded = await Reimbursement.findByPk(r.id, { include: INCLUDE });
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
    const r = await loadOwned(req);
    if (!r) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
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
    if (repayment.currency !== r.currency) {
      res.status(400).json({
        error: `Repayment currency must match the claim (${r.currency})`,
      });
      return;
    }
    r.repaymentTransactionId = repayment.id;
    // Linking a repayment closes the claim as received (unless explicitly
    // waived already — keep waived as a terminal user choice).
    if (r.status !== 'waived') {
      r.status = 'received';
      r.receivedAt = new Date();
    }
    await r.save();
    const reloaded = await Reimbursement.findByPk(r.id, { include: INCLUDE });
    res.json({ data: serializeReimbursement(toRow(reloaded as Reimbursement)) });
  } catch (e) {
    next(e);
  }
});

// ----- POST /api/reimbursements/:id/unlink-repayment ----------------------

router.post('/reimbursements/:id/unlink-repayment', async (req, res, next) => {
  try {
    currentAuth(req);
    const r = await loadOwned(req);
    if (!r) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    r.repaymentTransactionId = null;
    // Reopen a received claim; leave waived/overdue pins as-is.
    if (r.status === 'received') {
      r.status = 'expected';
      r.receivedAt = null;
    }
    await r.save();
    const reloaded = await Reimbursement.findByPk(r.id, { include: INCLUDE });
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
