// Mount: app.use('/api/expectations', expectationsRouter); // after requireAuth

/**
 * Read-only unified view over the `expectations` table (issue #402).
 *
 * The expectations table is the canonical Expectation primitive — a superset
 * of the old PlannedEvent and Subscription shapes folded into one status
 * machine. Write operations still go to /api/planned-events and
 * /api/subscriptions for backwards compat; this route exposes a read-only
 * surface over the unified table for new consumers (dashboards, mobile, AI).
 *
 * Endpoints:
 *   GET /api/expectations
 *     ?cadence=one_shot|recurring   — filter by one-shot vs all recurring
 *     ?status=<ExpectationStatus>   — filter by status
 *     ?windowMonths=<N>             — limit expected_at to next N months
 *   GET /api/expectations/:id       — single row
 */

import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Expectation,
  EXPECTATION_CADENCES,
  EXPECTATION_STATUSES,
  type ExpectationCadence,
  type ExpectationStatus,
  type ExpectationType,
} from '../models/Expectation';
import { householdWhere } from '../auth/scope';

const router = Router();

/**
 * Serialised shape returned to API callers. Mirrors all Expectation fields
 * with camelCase keys and ISO strings for dates.
 */
interface ExpectationResponse {
  id: number;
  householdId: number;
  userId: number | null;
  accountId: number | null;
  cadence: ExpectationCadence;
  name: string;
  normalizedName: string | null;
  amount: string;
  currency: string;
  type: ExpectationType;
  status: ExpectationStatus;
  expectedAt: string | null;
  lastChargeDate: string | null;
  rrule: string | null;
  category: string | null;
  notes: string | null;
  annualizedCost: string | null;
  priceChangeDetected: boolean;
  cancellationUrl: string | null;
  source: string | null;
  linkedTransactionId: number | null;
  sourcePlannedEventId: number | null;
  sourceSubscriptionId: number | null;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: InstanceType<typeof Expectation>): ExpectationResponse {
  return {
    id: row.id,
    householdId: row.householdId,
    userId: row.userId,
    accountId: row.accountId,
    cadence: row.cadence,
    name: row.name,
    normalizedName: row.normalizedName,
    amount: String(row.amount),
    currency: row.currency,
    type: row.type,
    status: row.status,
    expectedAt: row.expectedAt,
    lastChargeDate: row.lastChargeDate,
    rrule: row.rrule,
    category: row.category,
    notes: row.notes,
    annualizedCost: row.annualizedCost != null ? String(row.annualizedCost) : null,
    priceChangeDetected: Boolean(row.priceChangeDetected),
    cancellationUrl: row.cancellationUrl,
    source: row.source,
    linkedTransactionId: row.linkedTransactionId,
    sourcePlannedEventId: row.sourcePlannedEventId,
    sourceSubscriptionId: row.sourceSubscriptionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * GET /api/expectations
 *
 * Query params:
 *   cadence       — 'one_shot' | 'recurring' | any single ExpectationCadence
 *                   'recurring' expands to all cadences != 'one_shot'
 *   status        — any ExpectationStatus value
 *   windowMonths  — positive integer; constrains expected_at to [today, +N months]
 */
router.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };

    // --- cadence filter ---
    if (req.query.cadence) {
      const raw = String(req.query.cadence);
      if (raw === 'recurring') {
        // MoneyLeak-style view: anything that is not a one-off
        where.cadence = { [Op.ne]: 'one_shot' };
      } else if ((EXPECTATION_CADENCES as readonly string[]).includes(raw)) {
        where.cadence = raw;
      } else {
        res.status(400).json({
          error: `cadence must be 'recurring', 'one_shot', or one of: ${EXPECTATION_CADENCES.join(', ')}`,
        });
        return;
      }
    }

    // --- status filter ---
    if (req.query.status) {
      const raw = String(req.query.status);
      if (!(EXPECTATION_STATUSES as readonly string[]).includes(raw)) {
        res.status(400).json({
          error: `status must be one of: ${EXPECTATION_STATUSES.join(', ')}`,
        });
        return;
      }
      where.status = raw as ExpectationStatus;
    }

    // --- windowMonths filter ---
    if (req.query.windowMonths) {
      const wm = parseInt(String(req.query.windowMonths), 10);
      if (!Number.isInteger(wm) || wm < 1) {
        res.status(400).json({ error: 'windowMonths must be a positive integer' });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date();
      future.setMonth(future.getMonth() + wm);
      const futureDate = future.toISOString().slice(0, 10);
      where.expectedAt = {
        [Op.or]: [
          { [Op.is]: null },
          { [Op.between]: [today, futureDate] },
        ],
      };
    }

    const rows = await Expectation.findAll({
      where,
      order: [
        ['expected_at', 'ASC'],
        ['created_at', 'ASC'],
      ],
    });

    res.json({ data: rows.map(serialize) });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/expectations/:id
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await Expectation.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

export default router;
