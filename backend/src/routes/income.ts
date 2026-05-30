import { Router } from 'express';
import { Op } from 'sequelize';
import crypto from 'crypto';
import { IncomeEntry, INCOME_SOURCES, type IncomeSource } from '../models/IncomeEntry';
import { Transaction } from '../models/Transaction';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';

const router = Router();

const VALID_SOURCES = new Set<string>(INCOME_SOURCES);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_CURRENCIES = /^[A-Z]{3}$/;

function requirePositiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function requireNonNegativeInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normalizeNullableInt(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.post('/', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { occurredOn, grossAmountCents, currency, taxWithheldCents, categoryId,
      counterpartyContactId, source, notes, accountId } = req.body as Record<string, unknown>;

    if (!ISO_DATE_RE.test(String(occurredOn ?? ''))) {
      res.status(400).json({ error: 'occurredOn must be YYYY-MM-DD' });
      return;
    }
    const gross = requirePositiveInt(grossAmountCents);
    if (gross === null) { res.status(400).json({ error: 'grossAmountCents must be a positive integer' }); return; }
    if (!VALID_CURRENCIES.test(String(currency ?? ''))) { res.status(400).json({ error: 'currency must be a 3-letter ISO code' }); return; }
    if (!VALID_SOURCES.has(String(source ?? ''))) { res.status(400).json({ error: `source must be one of: ${INCOME_SOURCES.join(', ')}` }); return; }

    const tax = taxWithheldCents != null ? requireNonNegativeInt(taxWithheldCents) : null;
    if (taxWithheldCents != null && tax === null) { res.status(400).json({ error: 'taxWithheldCents must be a non-negative integer' }); return; }
    if (tax !== null && tax > gross) { res.status(400).json({ error: "Tax can't exceed gross." }); return; }

    const net = gross - (tax ?? 0);

    const entry = await IncomeEntry.create({
      userId: auth.user.id,
      householdId: auth.household.id,
      occurredOn: String(occurredOn),
      grossAmountCents: gross,
      currency: String(currency),
      taxWithheldCents: tax,
      netAmountCents: net,
      categoryId: normalizeNullableInt(categoryId),
      counterpartyContactId: normalizeNullableInt(counterpartyContactId),
      source: String(source) as IncomeSource,
      notes: notes != null ? String(notes).slice(0, 4096) || null : null,
      accountId: normalizeNullableInt(accountId),
      linkedTransactionId: null,
    });

    // Create paired transaction if account_id provided
    if (entry.accountId) {
      const fingerprint = crypto
        .createHash('sha256')
        .update(`income_entry:${entry.id}`)
        .digest('hex');
      const txn = await Transaction.create({
        accountId: entry.accountId,
        householdId: auth.household.id,
        createdByUserId: auth.user.id,
        date: String(occurredOn),
        merchantRaw: `Income (${entry.source})`,
        merchantClean: `Income (${entry.source})`,
        amount: String((net / 100).toFixed(2)),
        currency: entry.currency,
        notes: entry.notes,
        importBatch: `income_entry:${entry.id}`,
        sourceRowFingerprint: fingerprint,
        sourceIdentityFingerprint: fingerprint,
        txnType: 'income',
        reviewFlag: false,
      });
      await entry.update({ linkedTransactionId: txn.id });
    }

    res.status(201).json(entry);
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { from, to, source, contactId, accountId } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {
      ...householdWhere(req),
    };
    if (from) where['occurredOn'] = { ...(where['occurredOn'] as Record<string, unknown> ?? {}), [Op.gte]: from };
    if (to) where['occurredOn'] = { ...(where['occurredOn'] as Record<string, unknown> ?? {}), [Op.lte]: to };
    if (source && VALID_SOURCES.has(source)) where['source'] = source;
    if (contactId) where['counterpartyContactId'] = Number(contactId);
    if (accountId) where['accountId'] = Number(accountId);

    const entries = await IncomeEntry.findAll({
      where,
      order: [['occurredOn', 'DESC'], ['id', 'DESC']],
      limit: 500,
    });

    res.json({ entries });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const entry = await IncomeEntry.findOne({
      where: { id: Number(req.params.id), ...householdWhere(req) },
    });
    if (!entry) { res.status(404).json({ error: 'Income entry not found' }); return; }

    const body = req.body as Record<string, unknown>;

    const occurredOn = body.occurredOn != null ? String(body.occurredOn) : entry.occurredOn;
    if (!ISO_DATE_RE.test(occurredOn)) { res.status(400).json({ error: 'occurredOn must be YYYY-MM-DD' }); return; }

    const gross = body.grossAmountCents != null
      ? requirePositiveInt(body.grossAmountCents)
      : entry.grossAmountCents;
    if (gross === null) { res.status(400).json({ error: 'grossAmountCents must be a positive integer' }); return; }

    const currency = body.currency != null ? String(body.currency) : entry.currency;
    if (!VALID_CURRENCIES.test(currency)) { res.status(400).json({ error: 'currency must be a 3-letter ISO code' }); return; }

    const source = body.source != null ? String(body.source) : entry.source;
    if (!VALID_SOURCES.has(source)) { res.status(400).json({ error: `source must be one of: ${INCOME_SOURCES.join(', ')}` }); return; }

    let tax: number | null = entry.taxWithheldCents;
    if ('taxWithheldCents' in body) {
      tax = body.taxWithheldCents != null ? requireNonNegativeInt(body.taxWithheldCents) : null;
      if (body.taxWithheldCents != null && tax === null) { res.status(400).json({ error: 'taxWithheldCents must be non-negative integer' }); return; }
    }
    if (tax !== null && gross !== null && tax > gross) { res.status(400).json({ error: "Tax can't exceed gross." }); return; }
    const net = gross - (tax ?? 0);

    await entry.update({
      occurredOn,
      grossAmountCents: gross,
      currency,
      taxWithheldCents: tax,
      netAmountCents: net,
      categoryId: 'categoryId' in body ? normalizeNullableInt(body.categoryId) : entry.categoryId,
      counterpartyContactId: 'counterpartyContactId' in body ? normalizeNullableInt(body.counterpartyContactId) : entry.counterpartyContactId,
      source: source as IncomeSource,
      notes: 'notes' in body ? (body.notes != null ? String(body.notes).slice(0, 4096) || null : null) : entry.notes,
    });

    // Update paired transaction if it exists
    if (entry.linkedTransactionId) {
      await Transaction.update(
        {
          amount: String((net / 100).toFixed(2)),
          currency,
          date: occurredOn,
          merchantRaw: `Income (${source})`,
          merchantClean: `Income (${source})`,
        },
        { where: { id: entry.linkedTransactionId } },
      );
    }

    res.json(entry);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const entry = await IncomeEntry.findOne({
      where: { id: Number(req.params.id), ...householdWhere(req) },
    });
    if (!entry) { res.status(404).json({ error: 'Income entry not found' }); return; }

    const linkedTxnId = entry.linkedTransactionId;
    await entry.destroy();
    if (linkedTxnId) {
      await Transaction.destroy({ where: { id: linkedTxnId } });
    }

    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
