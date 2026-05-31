import { Router } from 'express';
import { SubscriptionPriceChange } from '../models';
import { currentAuth } from '../auth/middleware';

const router = Router();

// GET /api/subscription-price-changes?status=unack|all
router.get('/', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    void user;
    const status = String(req.query.status ?? 'unack');
    const where: Record<string, unknown> = { householdId: household.id };
    if (status === 'unack') where.acknowledgedAt = null;

    const rows = await SubscriptionPriceChange.findAll({
      where,
      order: [['detected_on', 'DESC'], ['id', 'DESC']],
      limit: 200,
    });
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/subscription-price-changes/:id/acknowledge
router.post('/:id/acknowledge', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const id = Number(req.params.id);
    const row = await SubscriptionPriceChange.findOne({ where: { id } });
    if (!row) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    if (row.householdId !== household.id) { res.status(403).json({ error: 'FORBIDDEN' }); return; }
    await row.update({ acknowledgedAt: new Date(), acknowledgedByUserId: user.id });
    res.json(row);
  } catch (e) { next(e); }
});

export default router;
