/**
 * Manual income entry routes (issue #434).
 *
 * IncomeEntry is implemented as a Transaction variant:
 *   txnType = 'income'
 *   incomeSource = paycheck | invoice | cash | gift | refund | other
 *   grossAmount (nullable)
 *   taxWithheld (nullable)
 *   amount = net (grossAmount - taxWithheld, or the full amount if gross is absent)
 *
 * This respects the CLAUDE.md primitives rule: income is a Transaction wearing
 * a new shape (incomeSource + gross/tax fields), not a distinct status machine.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';

const router = Router();

const VALID_SOURCES = ['paycheck', 'invoice', 'cash', 'gift', 'refund', 'other'] as const;
type IncomeSource = typeof VALID_SOURCES[number];

function isValidSource(s: unknown): s is IncomeSource {
  return typeof s === 'string' && VALID_SOURCES.includes(s as IncomeSource);
}

/** Parse a positive decimal from an unknown value; returns null if absent or invalid. */
function posDecimal(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * POST /api/income
 *
 * Create a manual income entry. Returns the created transaction.
 *
 * Body:
 *   occurredOn: YYYY-MM-DD (required)
 *   grossAmount: number (required)
 *   currency: 3-letter (required)
 *   taxWithheld: number (optional, defaults to 0)
 *   source: incomeSource enum (optional, default 'other')
 *   notes: string (optional)
 *   merchantClean: string (optional, default source label)
 *   accountId: number (optional — links to an account for reconciliation)
 *   contactId: number (optional — counterparty)
 *   category: string (optional)
 */
router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const b = (req.body ?? {}) as Record<string, unknown>;

    if (typeof b.occurredOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.occurredOn)) {
      res.status(400).json({ error: 'occurredOn is required (YYYY-MM-DD)' });
      return;
    }
    const gross = posDecimal(b.grossAmount);
    if (gross == null || gross <= 0) {
      res.status(400).json({ error: 'grossAmount must be a positive number' });
      return;
    }
    if (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency)) {
      res.status(400).json({ error: 'currency must be a 3-letter code' });
      return;
    }

    const taxWithheld = posDecimal(b.taxWithheld) ?? 0;
    const net = gross - taxWithheld;
    const source: IncomeSource = isValidSource(b.source) ? b.source : 'other';

    const SOURCE_LABELS: Record<IncomeSource, string> = {
      paycheck: 'Paycheck',
      invoice: 'Invoice',
      cash: 'Cash income',
      gift: 'Gift',
      refund: 'Refund',
      other: 'Income',
    };

    const merchantClean =
      typeof b.merchantClean === 'string' && b.merchantClean.trim()
        ? b.merchantClean.trim().slice(0, 255)
        : SOURCE_LABELS[source];

    const notes =
      typeof b.notes === 'string' && b.notes.trim()
        ? b.notes.trim().slice(0, 4000)
        : null;

    const category =
      typeof b.category === 'string' && b.category.trim() ? b.category.trim() : null;

    const contactId =
      typeof b.contactId === 'number' && Number.isInteger(b.contactId) ? b.contactId : null;

    const accountId =
      typeof b.accountId === 'number' && Number.isInteger(b.accountId) ? b.accountId : null;

    const txn = await Transaction.create({
      householdId: household.id,
      accountId: accountId ?? null,
      date: b.occurredOn,
      merchantRaw: merchantClean,
      merchantClean,
      merchantCanonical: merchantClean,
      amount: String(net),
      currency: b.currency,
      notes,
      txnType: 'income',
      incomeSource: source,
      grossAmount: String(gross),
      taxWithheld: taxWithheld > 0 ? String(taxWithheld) : null,
      categoryOverride: category,
      finalCategory: category,
      counterpartyContactId: contactId,
      sourceRowFingerprint: `manual-income-${user.id}-${Date.now()}`,
      sourceIdentityFingerprint: `manual-income-${user.id}-${Date.now()}-${Math.random()}`,
      reviewFlag: false,
      finalSplitType: 'me',
      finalBusiness: false,
    });

    res.status(201).json(txn);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/income
 *
 * List manual income entries (transactions with txnType='income').
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD&source=paycheck&limit=50&offset=0
 */
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const today = new Date().toISOString().slice(0, 10);

    const from =
      typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? req.query.from
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() - 365);
            return d.toISOString().slice(0, 10);
          })();
    const to =
      typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? req.query.to
        : today;
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const where: Record<string, unknown> = {
      ...householdWhere(req),
      txnType: 'income',
      date: { [Op.between]: [from, to] },
    };
    if (isValidSource(req.query.source)) {
      where.incomeSource = req.query.source;
    }

    const { count, rows } = await Transaction.findAndCountAll({
      where,
      order: [['date', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
      attributes: [
        'id', 'date', 'merchantClean', 'amount', 'currency', 'grossAmount',
        'taxWithheld', 'incomeSource', 'notes', 'finalCategory', 'accountId',
        'counterpartyContactId', 'createdAt',
      ],
    });

    res.json({ total: count, limit, offset, entries: rows });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/income/:id
 *
 * Update a manual income entry. Only income-type transactions may be patched here.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = parseInt(req.params.id, 10);
    const row = await Transaction.findOne({
      where: { id, ...householdWhere(req), txnType: 'income' },
    });
    if (!row) {
      res.status(404).json({ error: 'Income entry not found' });
      return;
    }

    const b = (req.body ?? {}) as Record<string, unknown>;

    if (typeof b.occurredOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.occurredOn)) {
      row.set('date', b.occurredOn);
    }
    if (typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency)) {
      row.set('currency', b.currency);
    }
    if (isValidSource(b.source)) {
      row.set('incomeSource', b.source);
    }

    const gross = posDecimal(b.grossAmount);
    const tax = posDecimal(b.taxWithheld);
    if (gross != null) {
      row.set('grossAmount', String(gross));
      const currentTax = tax ?? posDecimal(row.taxWithheld) ?? 0;
      row.set('taxWithheld', currentTax > 0 ? String(currentTax) : null);
      row.set('amount', String(gross - currentTax));
    } else if (tax != null) {
      const currentGross = posDecimal(row.grossAmount) ?? Number(row.amount);
      row.set('taxWithheld', tax > 0 ? String(tax) : null);
      row.set('amount', String(currentGross - tax));
    }

    if (typeof b.notes === 'string') {
      row.set('notes', b.notes.trim().slice(0, 4000) || null);
    }
    if (typeof b.merchantClean === 'string' && b.merchantClean.trim()) {
      row.set('merchantClean', b.merchantClean.trim().slice(0, 255));
    }
    if (typeof b.category === 'string') {
      const cat = b.category.trim() || null;
      row.set('categoryOverride', cat);
      row.set('finalCategory', cat);
    }

    await row.save();
    res.json(row);
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/income/:id
 *
 * Delete a manual income entry.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const row = await Transaction.findOne({
      where: { id: parseInt(req.params.id, 10), ...householdWhere(req), txnType: 'income' },
    });
    if (!row) {
      res.status(404).json({ error: 'Income entry not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
