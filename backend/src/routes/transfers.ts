/**
 * Transfer reconciliation endpoints (issue #222).
 *
 * Money frequently moves between accounts owned by the same person or
 * household — chequing → savings, business → personal owner draw,
 * reimbursements, brokerage funding, etc. These movements show up as a
 * pair of transactions (one outbound on the source account, one inbound
 * on the destination). The enrichment pipeline auto-links high-confidence
 * pairs (`backend/src/import/enrichment/detectRelationshipsStage.ts`),
 * but FX conversions, multi-day clearing windows, and unusual narratives
 * leave a long tail of unmatched transfers the user needs to review and
 * link by hand.
 *
 * This router provides:
 *   - GET  /api/transfers/unmatched          – review queue (txn_type=transfer, no link)
 *   - GET  /api/transfers/suggestions/:id    – live "did you mean these?" candidates for one txn
 *   - POST /api/transfers/link               – link two arbitrary transactions across accounts
 *   - POST /api/transfers/unlink             – clear both sides of a transfer link
 *   - PATCH /api/transfers/:id/purpose       – classify a linked transfer pair
 *   - GET  /api/transfers/money-movement     – aggregate sums by (source_account, dest_account)
 *
 * All endpoints are household-scoped via {@link visibleTransactionWhere}.
 * Multi-currency support: link/suggestions DO NOT require equal amounts —
 * the auto-detector already handles same-currency equal-amount, and FX
 * conversions deliberately have different amounts on each side.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction, sequelize } from '../models';
import { serializeTransaction } from '../util/serializeTransaction';
import { visibleTransactionWhere } from '../auth/scope';
import { logger } from '../observability/logger';
import { isTaxTreatment, type TaxTreatment } from '@cashflow/shared';
import {
  aggregateMoneyMovement,
  summarizeReciprocity,
  type MovementRow,
  type ReciprocityLeg,
} from '../transfers/reciprocity';

/**
 * Valid `transfer_purpose` values. Mirrors {@link TransferPurpose} in
 * `shared/api-types.ts` but kept locally as a runtime constant so the
 * backend doesn't depend on a value (vs type) export from a workspace
 * sibling — keeps the dependency graph one-way (shared → backend) for
 * everything except the type alias used by clients.
 */
export const TRANSFER_PURPOSES = [
  'owner_draw',
  'owner_contribution',
  'reimbursement',
  'investment',
  'internal',
  'income',
] as const;
export type TransferPurpose = (typeof TRANSFER_PURPOSES)[number];

const router = Router();

const VALID_PURPOSES = new Set<string>(TRANSFER_PURPOSES);

/**
 * Window (days) used by /suggestions for amount-equal and sourceReference
 * matches. Matches the default `transferWindowDays` used by the enrichment
 * pipeline. Wider than necessary on purpose: a stale unmatched transfer
 * may sit in the queue for weeks while the user catches up on imports.
 */
export const SUGGESTION_WINDOW_DAYS = 7;

/** Tolerance (absolute units) for equal-amount matching. */
const AMOUNT_TOLERANCE = 0.01;

function asNumberId(raw: unknown): number | null {
  const n = parseInt(String(raw), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(
    Math.round(
      (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) /
        86400000,
    ),
  );
}

/**
 * Pure scoring helper used by /suggestions. Higher score = better candidate.
 * Exported for unit testing.
 *
 * Score components:
 *   - sourceReference exact match: huge bonus (auto-link confidence). +100.
 *   - opposite-sign amount: +20 (transfers are always one positive + one negative).
 *   - amount equality (within AMOUNT_TOLERANCE): +50.
 *   - cross-account: +10 (you can't transfer to yourself).
 *   - close in time: up to +30 (1.0 at same day, 0 at window edge).
 *
 * Returns 0 for clearly-incompatible candidates so the caller can drop them.
 */
export function scoreTransferCandidate(
  txn: {
    accountId: number;
    amount: number;
    date: string;
    sourceReference: string | null;
    currency: string;
  },
  candidate: {
    accountId: number;
    amount: number;
    date: string;
    sourceReference: string | null;
    currency: string;
  },
  windowDays: number,
): number {
  if (candidate.accountId === txn.accountId) return 0;
  const days = daysBetween(txn.date, candidate.date);
  if (days > windowDays) return 0;
  let score = 10; // cross-account base
  // Opposite-sign: ALWAYS required for a real transfer.
  if (Math.sign(candidate.amount) === -Math.sign(txn.amount) && txn.amount !== 0) {
    score += 20;
  } else {
    // Same-sign candidates can't be the other half of a transfer.
    return 0;
  }
  // Closer in time → higher score (linear decay).
  score += Math.max(0, 30 * (1 - days / Math.max(1, windowDays)));
  // sourceReference exact match: very strong signal (FX-pair linker).
  if (
    txn.sourceReference != null &&
    candidate.sourceReference != null &&
    txn.sourceReference === candidate.sourceReference
  ) {
    score += 100;
  }
  // Same-currency equal-amount: very strong signal.
  if (
    txn.currency === candidate.currency &&
    Math.abs(Math.abs(txn.amount) - Math.abs(candidate.amount)) <= AMOUNT_TOLERANCE
  ) {
    score += 50;
  }
  return score;
}

/**
 * GET /api/transfers/unmatched
 *
 * Lists all transactions whose `txn_type='transfer'` AND
 * `linked_transaction_id IS NULL`. Scoped to the caller's household.
 * Ordered most-recent-first to mimic the dashboard queue UX.
 *
 * Query params:
 *   - page (1-based, default 1)
 *   - pageSize (default 25, max 100)
 *   - accountId (optional filter)
 */
router.get('/unmatched', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize ?? '25'), 10)),
    );
    const offset = (page - 1) * pageSize;
    const where: Record<string, unknown> = {
      ...visibleTransactionWhere(req),
      txnType: 'transfer',
      linkedTransactionId: null,
    };
    if (req.query.accountId) {
      const aid = asNumberId(req.query.accountId);
      if (aid != null) where.accountId = aid;
    }
    const { rows, count } = await Transaction.findAndCountAll({
      where,
      include: [
        {
          model: Account,
          as: 'account',
          attributes: ['id', 'name', 'shortCode'],
        },
      ],
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: pageSize,
      offset,
    });
    res.json({
      data: rows.map((r) => serializeTransaction(r)),
      page,
      pageSize,
      total: count,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transfers/suggestions/:id
 *
 * Returns candidate sibling transactions that could be the other half of
 * the transfer identified by `:id`. Same household, different account,
 * opposite-signed amount, within {@link SUGGESTION_WINDOW_DAYS}. Sorted by
 * score (descending) — first result is the most likely match.
 *
 * Critically, this endpoint DOES NOT require equal amounts. FX conversion
 * pairs (e.g. 5,207.60 USD ↔ 7,084.89 CAD) move different amounts, and the
 * UI needs to suggest them to the user for manual linking.
 *
 * Query params:
 *   - limit (default 10, max 50)
 *   - windowDays (default {@link SUGGESTION_WINDOW_DAYS}, max 90)
 */
router.get('/suggestions/:id', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10)));
    const windowDays = Math.min(
      90,
      Math.max(
        1,
        parseInt(String(req.query.windowDays ?? String(SUGGESTION_WINDOW_DAYS)), 10),
      ),
    );

    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (txn.linkedTransactionId != null) {
      // Already linked — no suggestions needed. Surface the linked sibling
      // so the UI can show it.
      const sibling = await Transaction.findOne({
        where: { id: txn.linkedTransactionId, ...visibleTransactionWhere(req) },
        include: [
          { model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] },
        ],
      });
      res.json({
        alreadyLinked: true,
        sibling: sibling ? serializeTransaction(sibling) : null,
        candidates: [],
      });
      return;
    }

    // Pull household candidates inside the window. Keep the SQL filter narrow
    // — the JS-side `scoreTransferCandidate` does final shaping.
    const txnDateMs = new Date(`${txn.date}T00:00:00Z`).getTime();
    const fromDate = new Date(txnDateMs - windowDays * 86400000)
      .toISOString()
      .slice(0, 10);
    const toDate = new Date(txnDateMs + windowDays * 86400000)
      .toISOString()
      .slice(0, 10);

    const txnAmount = Number(txn.amount);
    const candidates = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        id: { [Op.ne]: id },
        accountId: { [Op.ne]: txn.accountId },
        linkedTransactionId: null,
        date: { [Op.between]: [fromDate, toDate] },
      },
      include: [
        { model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] },
      ],
      limit: 200,
      order: [['date', 'DESC']],
    });

    const scored = candidates
      .map((c) => {
        const score = scoreTransferCandidate(
          {
            accountId: txn.accountId,
            amount: txnAmount,
            date: txn.date,
            sourceReference: txn.sourceReference,
            currency: txn.currency,
          },
          {
            accountId: c.accountId,
            amount: Number(c.amount),
            date: c.date,
            sourceReference: c.sourceReference,
            currency: c.currency,
          },
          windowDays,
        );
        return { c, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        ...serializeTransaction(s.c),
        suggestionScore: s.score,
      }));

    res.json({
      alreadyLinked: false,
      candidates: scored,
      windowDays,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transfers/link
 *
 * Links two arbitrary transactions as a transfer pair.
 *
 * Body: `{ idA: number, idB: number, purpose?: TransferPurpose }`
 *
 * Effects (atomic):
 *   - Both rows get `txn_type='transfer'`.
 *   - Each row's `linked_transaction_id` points at the other.
 *   - Both get the same `transfer_purpose` (if provided).
 *   - Both get `transfer_linked_at=now()`.
 *
 * Refuses:
 *   - 400 if idA == idB.
 *   - 400 if either is already linked (caller must /unlink first to avoid
 *     orphaning the previous sibling).
 *   - 400 if the two rows are on the same account (a transfer cannot
 *     happen within one account).
 *   - 400 if purpose is provided but not in {@link TRANSFER_PURPOSES}.
 *   - 404 if either row isn't visible to the caller.
 */
router.post('/link', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const idA = asNumberId(body.idA);
    const idB = asNumberId(body.idB);
    if (idA == null || idB == null) {
      res.status(400).json({ error: 'idA and idB must be positive integers' });
      return;
    }
    if (idA === idB) {
      res.status(400).json({ error: 'idA and idB must differ' });
      return;
    }
    let purpose: TransferPurpose | null = null;
    if (body.purpose !== undefined && body.purpose !== null && body.purpose !== '') {
      if (typeof body.purpose !== 'string' || !VALID_PURPOSES.has(body.purpose)) {
        res.status(400).json({
          error: `purpose must be one of ${TRANSFER_PURPOSES.join(', ')}`,
        });
        return;
      }
      purpose = body.purpose as TransferPurpose;
    }

    const result = await sequelize.transaction(async (t) => {
      // Both reads share transaction `t` (one pg connection), so they must run
      // sequentially — Promise.all pipelines queries on the same client
      // ("already executing a query", a hard error in pg@9).
      const a = await Transaction.findOne({
        where: { id: idA, ...visibleTransactionWhere(req) },
        transaction: t,
      });
      const b = await Transaction.findOne({
        where: { id: idB, ...visibleTransactionWhere(req) },
        transaction: t,
      });
      if (!a || !b) {
        const err = new Error('Transaction not found') as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      if (a.accountId === b.accountId) {
        const err = new Error('Cannot link two transactions on the same account') as Error & {
          status?: number;
        };
        err.status = 400;
        throw err;
      }
      if (a.linkedTransactionId != null || b.linkedTransactionId != null) {
        const err = new Error(
          'One or both transactions are already linked — unlink first',
        ) as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const linkedAt = new Date();
      a.set('txnType', 'transfer');
      a.set('linkedTransactionId', b.id);
      a.set('transferPurpose', purpose);
      a.set('transferLinkedAt', linkedAt);
      b.set('txnType', 'transfer');
      b.set('linkedTransactionId', a.id);
      b.set('transferPurpose', purpose);
      b.set('transferLinkedAt', linkedAt);
      await a.save({ transaction: t });
      await b.save({ transaction: t });
      return { a, b };
    });

    logger.info(
      {
        idA,
        idB,
        purpose,
        householdId: result.a.householdId,
      },
      'transfer_linked',
    );

    await Promise.all([
      result.a.reload({
        include: [
          { model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] },
        ],
      }),
      result.b.reload({
        include: [
          { model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] },
        ],
      }),
    ]);
    res.json({
      a: serializeTransaction(result.a),
      b: serializeTransaction(result.b),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transfers/unlink
 *
 * Clears the transfer link on both sides of a pair. Body: `{ id }`.
 * Looks up the sibling via `linked_transaction_id`, then nulls both rows'
 * `linked_transaction_id`, `transfer_purpose`, `transfer_linked_at`.
 *
 * Keeps `txn_type='transfer'` intact — the rows are still classified as
 * transfers, just not paired anymore. They'll show up in /unmatched.
 *
 * Refuses with 400 if the row has no link.
 */
router.post('/unlink', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const id = asNumberId(body.id);
    if (id == null) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }

    const result = await sequelize.transaction(async (t) => {
      const a = await Transaction.findOne({
        where: { id, ...visibleTransactionWhere(req) },
        transaction: t,
      });
      if (!a) {
        const err = new Error('Not found') as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      if (a.linkedTransactionId == null) {
        const err = new Error('Transaction is not linked') as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const b = await Transaction.findOne({
        where: { id: a.linkedTransactionId, ...visibleTransactionWhere(req) },
        transaction: t,
      });
      // Even if the sibling row isn't visible (cross-household orphan from a
      // historical bug), we still want to clear `a` so the user can re-pair.
      a.set('linkedTransactionId', null);
      a.set('transferPurpose', null);
      a.set('transferLinkedAt', null);
      await a.save({ transaction: t });
      if (b) {
        b.set('linkedTransactionId', null);
        b.set('transferPurpose', null);
        b.set('transferLinkedAt', null);
        await b.save({ transaction: t });
      }
      return { a, b };
    });

    logger.info(
      {
        idA: result.a.id,
        idB: result.b?.id ?? null,
        householdId: result.a.householdId,
      },
      'transfer_unlinked',
    );

    res.json({
      a: serializeTransaction(result.a),
      b: result.b ? serializeTransaction(result.b) : null,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/transfers/:id/purpose
 *
 * Updates `transfer_purpose` on a linked pair. Both sides of the link
 * get the same value to keep the pair self-consistent.
 *
 * Body: `{ purpose: TransferPurpose | null }`.  null clears the purpose
 * (e.g. user un-classifies a previously-classified pair).
 *
 * Refuses with 400 if the row has no link (purpose is only meaningful
 * once a pair exists; nothing prevents a future enhancement that allows
 * unpaired transfers to carry a tentative purpose).
 */
router.patch('/:id/purpose', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    let purpose: TransferPurpose | null;
    if (body.purpose === null || body.purpose === undefined || body.purpose === '') {
      purpose = null;
    } else if (typeof body.purpose === 'string' && VALID_PURPOSES.has(body.purpose)) {
      purpose = body.purpose as TransferPurpose;
    } else {
      res.status(400).json({
        error: `purpose must be null or one of ${TRANSFER_PURPOSES.join(', ')}`,
      });
      return;
    }

    const result = await sequelize.transaction(async (t) => {
      const a = await Transaction.findOne({
        where: { id, ...visibleTransactionWhere(req) },
        transaction: t,
      });
      if (!a) {
        const err = new Error('Not found') as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      if (a.linkedTransactionId == null) {
        const err = new Error(
          'Transaction is not linked — cannot set transfer purpose',
        ) as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const b = await Transaction.findOne({
        where: { id: a.linkedTransactionId, ...visibleTransactionWhere(req) },
        transaction: t,
      });
      a.set('transferPurpose', purpose);
      await a.save({ transaction: t });
      if (b) {
        b.set('transferPurpose', purpose);
        await b.save({ transaction: t });
      }
      return { a, b };
    });

    res.json({
      a: serializeTransaction(result.a),
      b: result.b ? serializeTransaction(result.b) : null,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/transfers/:id/tax-treatment
 *
 * Sets `tax_treatment` on a transaction. If the row is linked (a transfer
 * pair), both legs get the same value. Unlinked rows (e.g. a payroll deposit)
 * are allowed — only that row is updated. null/'' clears the treatment.
 */
router.patch('/:id/tax-treatment', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const raw = body.taxTreatmentOverride;
    let treatment: TaxTreatment | null;
    if (raw === null || raw === undefined || raw === '') {
      treatment = null;
    } else if (isTaxTreatment(raw)) {
      treatment = raw;
    } else {
      res.status(400).json({ error: 'invalid taxTreatment' });
      return;
    }

    const result = await sequelize.transaction(async (t) => {
      const a = await Transaction.findOne({
        where: { id, ...visibleTransactionWhere(req) },
        transaction: t,
      });
      if (!a) {
        const err = new Error('Not found') as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      const reviewedAt = new Date();
      a.set('taxTreatmentOverride', treatment);
      a.set('reviewedAt', reviewedAt);
      await a.save({ transaction: t });
      let b = null;
      if (a.linkedTransactionId != null) {
        b = await Transaction.findOne({
          where: { id: a.linkedTransactionId, ...visibleTransactionWhere(req) },
          transaction: t,
        });
        if (b) {
          b.set('taxTreatmentOverride', treatment);
          b.set('reviewedAt', reviewedAt);
          await b.save({ transaction: t });
        }
      }
      return { a, b };
    });

    res.json({
      a: serializeTransaction(result.a),
      b: result.b ? serializeTransaction(result.b) : null,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transfers/money-movement
 *
 * Aggregates linked transfers into a "money movement map" — a list of
 * (sourceAccountId → destAccountId) rows with summed amount + count. The
 * source side is the negative leg; the destination is the positive leg.
 *
 * For multi-currency pairs both legs' native amounts are reported (no FX
 * conversion). The UI can pick which currency to show; the data is
 * faithful to what landed in each account.
 *
 * Query params:
 *   - dateFrom (ISO YYYY-MM-DD, optional)
 *   - dateTo (ISO YYYY-MM-DD, optional)
 *   - purpose (TransferPurpose, optional — filter to one classification)
 */
router.get('/money-movement', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = {
      ...visibleTransactionWhere(req),
      txnType: 'transfer',
      linkedTransactionId: { [Op.ne]: null },
    };
    if (req.query.dateFrom || req.query.dateTo) {
      const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
      if (req.query.dateFrom) dateCond[Op.gte] = String(req.query.dateFrom);
      if (req.query.dateTo) dateCond[Op.lte] = String(req.query.dateTo);
      where.date = dateCond;
    }
    if (req.query.purpose) {
      const p = String(req.query.purpose);
      if (!VALID_PURPOSES.has(p)) {
        res.status(400).json({
          error: `purpose must be one of ${TRANSFER_PURPOSES.join(', ')}`,
        });
        return;
      }
      where.transferPurpose = p;
    }
    const rows = await Transaction.findAll({
      where,
      include: [
        { model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] },
      ],
      order: [['date', 'ASC']],
    });

    type RowWithAccount = (typeof rows)[number] & {
      account?: { id: number; name: string; shortCode: string | null };
    };

    const toMovementRow = (r: RowWithAccount): MovementRow => ({
      id: r.id,
      accountId: r.accountId,
      accountName: r.account?.name ?? `Account #${r.accountId}`,
      amount: Number(r.amount),
      currency: r.currency,
      linkedTransactionId: r.linkedTransactionId,
      transferPurpose: r.transferPurpose ?? null,
    });

    const anchors = (rows as RowWithAccount[]).map(toMovementRow);

    // When a date window is applied a leg's reciprocating sibling may fall
    // outside the window; without it the pair would be mis-classified as
    // dangling. Load those siblings (no date filter) purely to resolve
    // reciprocity — they are not aggregated as anchors.
    let siblingLookup: MovementRow[] | undefined;
    if (req.query.dateFrom || req.query.dateTo) {
      const siblingIds = anchors
        .map((a) => a.linkedTransactionId)
        .filter((id): id is number => id != null);
      if (siblingIds.length > 0) {
        const siblingRows = (await Transaction.findAll({
          where: {
            ...visibleTransactionWhere(req),
            txnType: 'transfer',
            id: { [Op.in]: siblingIds },
          },
          include: [
            { model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] },
          ],
        })) as RowWithAccount[];
        siblingLookup = siblingRows.map(toMovementRow);
      }
    }

    const { flows, dangling } = aggregateMoneyMovement(anchors, siblingLookup);

    res.json({
      flows,
      dangling,
      unmatchedCount: await Transaction.count({
        where: {
          ...visibleTransactionWhere(req),
          txnType: 'transfer',
          linkedTransactionId: null,
        },
      }),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transfers/stats
 *
 * Quick scalar summary for the page header:
 *   - `matched`   — count of RECIPROCAL pairs (A↔B), counted once per pair.
 *   - `unmatched` — transfer legs with no link at all.
 *   - `dangling`  — legs with a one-way / broken link (A→B but not B→A).
 *                   Previously these inflated `matched`; issue #553.
 *   - `byPurpose` — reciprocal-pair count keyed by purpose (one per pair).
 *
 * Loads the linked legs (id + link + purpose) to evaluate reciprocity in
 * memory via {@link summarizeReciprocity}; the link column is indexed so the
 * scan is cheap.
 */
router.get('/stats', async (req, res, next) => {
  try {
    const baseWhere = {
      ...visibleTransactionWhere(req),
      txnType: 'transfer',
    } as Record<string, unknown>;

    const linkedRows = (await Transaction.findAll({
      where: { ...baseWhere, linkedTransactionId: { [Op.ne]: null } },
      attributes: ['id', 'linkedTransactionId', 'transferPurpose'],
      raw: true,
    })) as unknown as ReciprocityLeg[];

    const summary = summarizeReciprocity(linkedRows);

    // Legs with no link at all are not in `linkedRows`; count them directly.
    const unmatched = await Transaction.count({
      where: { ...baseWhere, linkedTransactionId: null },
    });

    res.json({
      matched: summary.matched,
      unmatched,
      dangling: summary.dangling,
      byPurpose: summary.byPurpose,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
