import { Router } from 'express';
import { Rule, Transaction } from '../models';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const rules = await Rule.findAll({
      order: [
        ['priority', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    const out = [];
    for (const r of rules) {
      const usageCount = await Transaction.count({
        where: { appliedRuleId: r.get('id') as number },
      });
      out.push({ ...r.toJSON(), usageCount });
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    if (!b.merchantPattern) {
      res.status(400).json({ error: 'merchantPattern is required' });
      return;
    }
    const row = await Rule.create({
      merchantPattern: String(b.merchantPattern),
      matchKind: (b.matchKind as string) || 'substring',
      priority: b.priority != null ? Number(b.priority) : 0,
      category: (b.category as string | null) ?? null,
      isBusiness: Boolean(b.isBusiness),
      splitType: (b.splitType as string) || 'me',
      pctMe: b.pctMe != null ? String(b.pctMe) : null,
      pctPartner: b.pctPartner != null ? String(b.pctPartner) : null,
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Rule.findByPk(id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    const fields = [
      'merchantPattern',
      'matchKind',
      'priority',
      'category',
      'isBusiness',
      'splitType',
      'pctMe',
      'pctPartner',
    ] as const;
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(b, f)) row.set(f, b[f]);
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
    const row = await Rule.findByPk(id);
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

export default router;
