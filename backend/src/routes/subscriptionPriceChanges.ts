import { Router } from 'express';
import { Op } from 'sequelize';
import { SubscriptionPriceChange, Subscription } from '../models';
import { currentAuth } from '../auth/middleware';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const status = typeof req.query.status === 'string' ? req.query.status : 'unack';

    const where: Record<string, unknown> = { householdId: household.id };
    if (status === 'unack') {
      where.acknowledgedAt = null;
    }

    const rows = await SubscriptionPriceChange.findAll({
      where,
      order: [['detected_on', 'DESC'], ['id', 'DESC']],
      limit: 200,
    });

    const subIds = [...new Set(rows.map((r) => r.subscriptionId))];
    const subs = subIds.length > 0
      ? await Subscription.findAll({ where: { id: { [Op.in]: subIds }, householdId: household.id } })
      : [];
    const subMap = new Map(subs.map((s) => [s.id, s.merchantName]));

    const out = rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscriptionId,
      merchantName: subMap.get(r.subscriptionId) ?? null,
      detectedOn: r.detectedOn,
      previousAmountCents: r.previousAmountCents,
      newAmountCents: r.newAmountCents,
      pctChange: Number(r.pctChange),
      currency: r.currency,
      acknowledgedAt: r.acknowledgedAt ?? null,
    }));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/acknowledge', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    const row = await SubscriptionPriceChange.findOne({
      where: { id, householdId: household.id },
    });
    if (!row) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    await row.update({ acknowledgedAt: new Date(), acknowledgedByUserId: user.id });

    // Clear the boolean flag if no more unacknowledged changes for this subscription
    const remaining = await SubscriptionPriceChange.count({
      where: { subscriptionId: row.subscriptionId, acknowledgedAt: null },
    });
    if (remaining === 0) {
      await Subscription.update(
        { priceChangeDetected: false },
        { where: { id: row.subscriptionId } },
      );
    }

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
