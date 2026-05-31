import { Router } from 'express';
import { Op } from 'sequelize';
import { IncomeEntry, Transaction, sequelize } from '../models';
import { currentAuth } from '../auth/middleware';
import { INCOME_SOURCES } from '../models/IncomeEntry';

const router = Router();

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// POST / — create a new income entry
router.post('/', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const {
      occurredOn,
      grossAmountCents,
      currency,
      taxWithheldCents,
      categoryId,
      counterpartyContactId,
      source,
      notes,
      accountId,
    } = req.body as Record<string, unknown>;

    if (typeof occurredOn !== 'string' || !occurredOn) {
      res.status(400).json({ error: 'occurredOn is required (YYYY-MM-DD)' });
      return;
    }
    if (!grossAmountCents || Number(grossAmountCents) <= 0) {
      res.status(400).json({ error: 'grossAmountCents must be a positive integer' });
      return;
    }
    if (typeof currency !== 'string' || currency.length !== 3) {
      res.status(400).json({ error: 'currency must be a 3-letter code' });
      return;
    }
    const gross = BigInt(grossAmountCents as string | number);
    const tax = taxWithheldCents != null ? BigInt(taxWithheldCents as string | number) : 0n;
    if (tax > gross) {
      res.status(400).json({ error: 'Tax withheld cannot exceed gross amount' });
      return;
    }
    const net = gross - tax;

    if (source != null && !INCOME_SOURCES.includes(source as never)) {
      res.status(400).json({ error: `source must be one of: ${INCOME_SOURCES.join(', ')}` });
      return;
    }

    const entry = await sequelize.transaction(async (t) => {
      const created = await IncomeEntry.create(
        {
          userId: auth.user.id,
          householdId: auth.household.id,
          occurredOn: occurredOn as string,
          grossAmountCents: gross.toString(),
          currency: (currency as string).toUpperCase(),
          taxWithheldCents: taxWithheldCents != null ? tax.toString() : null,
          netAmountCents: net.toString(),
          categoryId: num(categoryId as string | null) ?? null,
          counterpartyContactId: num(counterpartyContactId as string | null) ?? null,
          source: (source as string | undefined) ?? 'other',
          notes: typeof notes === 'string' ? notes : null,
          accountId: num(accountId as string | null) ?? null,
          linkedTransactionId: null,
        },
        { transaction: t },
      );

      // If accountId provided, also create a paired Transaction
      if (created.accountId != null) {
        const txn = await Transaction.create(
          {
            accountId: created.accountId,
            userId: auth.user.id,
            householdId: auth.household.id,
            date: occurredOn as string,
            description: `Income: ${source ?? 'other'}`,
            amount: Number(net) / 100,
            currency: (currency as string).toUpperCase(),
            type: 'income',
            status: 'cleared',
            source: 'manual',
          } as never,
          { transaction: t },
        );
        await created.update({ linkedTransactionId: txn.id }, { transaction: t });
      }

      return created;
    });

    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

// GET / — list income entries with optional filters
router.get('/', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { from, to, source, contactId, accountId } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {
      householdId: auth.household.id,
    };

    if (from || to) {
      const dateClause: Record<symbol, string> = {};
      if (from) dateClause[Op.gte] = from;
      if (to) dateClause[Op.lte] = to;
      where['occurredOn'] = dateClause;
    }
    if (source) where['source'] = source;
    if (contactId) where['counterpartyContactId'] = Number(contactId);
    if (accountId) where['accountId'] = Number(accountId);

    const entries = await IncomeEntry.findAll({
      where,
      order: [['occurred_on', 'DESC'], ['id', 'DESC']],
      limit: 200,
    });

    res.json({ data: entries });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id — partial update
router.patch('/:id', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const id = Number(req.params.id);
    const entry = await IncomeEntry.findOne({
      where: { id, householdId: auth.household.id },
    });
    if (!entry) { res.status(404).json({ error: 'Not found' }); return; }

    const allowed = [
      'occurredOn', 'grossAmountCents', 'currency', 'taxWithheldCents',
      'categoryId', 'counterpartyContactId', 'source', 'notes', 'accountId',
    ] as const;
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in (req.body as object)) patch[key] = (req.body as Record<string, unknown>)[key];
    }

    // Recompute net if gross or tax changed
    if ('grossAmountCents' in patch || 'taxWithheldCents' in patch) {
      const gross = BigInt(String(patch['grossAmountCents'] ?? entry.grossAmountCents));
      const taxRaw = patch['taxWithheldCents'] ?? entry.taxWithheldCents ?? '0';
      const tax = BigInt(String(taxRaw));
      if (tax > gross) { res.status(400).json({ error: 'Tax withheld cannot exceed gross amount' }); return; }
      patch['netAmountCents'] = (gross - tax).toString();
    }

    await entry.update(patch);

    // Sync paired transaction if linked and net changed
    if (entry.linkedTransactionId != null && 'netAmountCents' in patch) {
      await Transaction.update(
        { amount: Number(entry.netAmountCents) / 100 } as never,
        { where: { id: entry.linkedTransactionId } },
      );
    }

    res.json(entry);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id
router.delete('/:id', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const id = Number(req.params.id);
    const entry = await IncomeEntry.findOne({
      where: { id, householdId: auth.household.id },
    });
    if (!entry) { res.status(404).json({ error: 'Not found' }); return; }

    const linkedTxnId = entry.linkedTransactionId;
    await entry.destroy();
    if (linkedTxnId != null) {
      await Transaction.destroy({ where: { id: linkedTxnId } });
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
