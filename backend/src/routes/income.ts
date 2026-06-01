import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, IncomeEntry, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';

const router = Router();

const VALID_SOURCES = new Set(['paycheck', 'invoice', 'cash', 'gift', 'refund', 'other']);

function validateInput(body: Record<string, unknown>): {
  error?: string;
  occurredOn?: string;
  grossAmountCents?: number;
  currency?: string;
  taxWithheldCents?: number | null;
  netAmountCents?: number;
  source?: string;
} {
  const { occurredOn, grossAmountCents, currency, taxWithheldCents, source } = body;

  if (!occurredOn || typeof occurredOn !== 'string') return { error: 'occurredOn is required' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) return { error: 'occurredOn must be YYYY-MM-DD' };
  if (typeof grossAmountCents !== 'number' || !Number.isInteger(grossAmountCents) || grossAmountCents <= 0) {
    return { error: 'grossAmountCents must be a positive integer' };
  }
  if (!currency || typeof currency !== 'string' || !/^[A-Z]{3}$/i.test(currency)) {
    return { error: 'currency must be a 3-letter ISO code' };
  }
  const taxCents = taxWithheldCents == null ? null : Number(taxWithheldCents);
  if (taxCents !== null && (!Number.isInteger(taxCents) || taxCents < 0)) {
    return { error: 'taxWithheldCents must be a non-negative integer' };
  }
  if (taxCents !== null && taxCents > grossAmountCents) {
    return { error: "Tax can't exceed gross." };
  }
  if (source !== undefined && !VALID_SOURCES.has(String(source))) {
    return { error: `source must be one of: ${[...VALID_SOURCES].join(', ')}` };
  }
  const netAmountCents = taxCents != null ? grossAmountCents - taxCents : grossAmountCents;
  return { occurredOn, grossAmountCents, currency: currency.toUpperCase(), taxWithheldCents: taxCents, netAmountCents, source: String(source ?? 'other') };
}

// GET /api/income
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const { from, to, source, contactId, accountId } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = { householdId: household.id };
    if (from) where.occurredOn = { ...(where.occurredOn as object ?? {}), [Op.gte]: from };
    if (to) where.occurredOn = { ...(where.occurredOn as object ?? {}), [Op.lte]: to };
    if (source) where.source = source;
    if (contactId) where.counterpartyContactId = Number(contactId);
    if (accountId) where.accountId = Number(accountId);

    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Number(req.query.offset ?? 0);

    const { count, rows } = await IncomeEntry.findAndCountAll({
      where,
      order: [['occurred_on', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
    });

    res.json({ total: count, items: rows });
  } catch (e) {
    next(e);
  }
});

// POST /api/income
router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const validated = validateInput(body);
    if (validated.error) {
      res.status(400).json({ error: 'INVALID_INPUT', message: validated.error });
      return;
    }

    const accountId = body.accountId ? Number(body.accountId) : null;
    let linkedTransactionId: number | null = null;

    if (accountId) {
      const account = await Account.findOne({ where: { id: accountId, householdId: household.id } });
      if (!account) {
        res.status(400).json({ error: 'INVALID_INPUT', message: 'Account not found' });
        return;
      }
      const grossInDollars = validated.grossAmountCents! / 100;
      const label = `Income: ${String(body.notes ?? validated.source ?? 'income')}`.slice(0, 255);
      const fp = randomUUID().replace(/-/g, '').slice(0, 32);
      const paired = await Transaction.create({
        householdId: household.id,
        createdByUserId: user.id,
        accountId,
        date: validated.occurredOn!,
        merchantRaw: label,
        merchantClean: label,
        amount: String(grossInDollars),
        currency: validated.currency!,
        txnType: 'credit',
        importBatch: 'manual-income',
        sourceRowFingerprint: fp,
        sourceIdentityFingerprint: fp,
        reviewFlag: false,
      });
      linkedTransactionId = paired.id;
    }

    const entry = await IncomeEntry.create({
      userId: user.id,
      householdId: household.id,
      occurredOn: validated.occurredOn!,
      grossAmountCents: validated.grossAmountCents!,
      currency: validated.currency!,
      taxWithheldCents: validated.taxWithheldCents ?? null,
      netAmountCents: validated.netAmountCents!,
      categoryId: body.categoryId ? Number(body.categoryId) : null,
      counterpartyContactId: body.counterpartyContactId ? Number(body.counterpartyContactId) : null,
      source: validated.source! as 'paycheck' | 'invoice' | 'cash' | 'gift' | 'refund' | 'other',
      notes: body.notes ? String(body.notes).slice(0, 4000) : null,
      accountId,
      linkedTransactionId,
    });

    res.status(201).json(entry);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/income/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    const entry = await IncomeEntry.findOne({ where: { id, householdId: household.id } });
    if (!entry) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const merged = {
      occurredOn: body.occurredOn ?? entry.occurredOn,
      grossAmountCents: body.grossAmountCents ?? entry.grossAmountCents,
      currency: body.currency ?? entry.currency,
      taxWithheldCents: 'taxWithheldCents' in body ? body.taxWithheldCents : entry.taxWithheldCents,
      source: body.source ?? entry.source,
    };
    const validated = validateInput(merged);
    if (validated.error) {
      res.status(400).json({ error: 'INVALID_INPUT', message: validated.error });
      return;
    }

    await entry.update({
      occurredOn: validated.occurredOn,
      grossAmountCents: validated.grossAmountCents,
      currency: validated.currency,
      taxWithheldCents: validated.taxWithheldCents ?? null,
      netAmountCents: validated.netAmountCents,
      source: validated.source as 'paycheck' | 'invoice' | 'cash' | 'gift' | 'refund' | 'other',
      categoryId: 'categoryId' in body ? (body.categoryId ? Number(body.categoryId) : null) : entry.categoryId,
      counterpartyContactId: 'counterpartyContactId' in body
        ? (body.counterpartyContactId ? Number(body.counterpartyContactId) : null)
        : entry.counterpartyContactId,
      notes: 'notes' in body ? (body.notes ? String(body.notes).slice(0, 4000) : null) : entry.notes,
    });

    if (entry.linkedTransactionId) {
      await Transaction.update(
        {
          date: validated.occurredOn,
          amount: String(validated.grossAmountCents! / 100),
          currency: validated.currency,
        },
        { where: { id: entry.linkedTransactionId, householdId: household.id } },
      );
    }

    await entry.reload();
    res.json(entry);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/income/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    const entry = await IncomeEntry.findOne({ where: { id, householdId: household.id } });
    if (!entry) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (entry.linkedTransactionId) {
      await Transaction.destroy({ where: { id: entry.linkedTransactionId, householdId: household.id } });
    }
    await entry.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
