/**
 * GET  /api/subscription-price-changes       — list unacknowledged (or all)
 * POST /api/subscription-price-changes/:id/acknowledge — mark acknowledged
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { SubscriptionPriceChange } from '../models/SubscriptionPriceChange';
import { Subscription } from '../models/Subscription';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';

const router = Router();

// GET /api/subscription-price-changes?status=unack|all
router.get('/', async (req, res, next) => {
  try {
    const status = String(req.query.status ?? 'unack');

    // Find subscriptions belonging to this household
    const subs = await Subscription.findAll({
      where: { ...householdWhere(req) },
      attributes: ['id'],
    });
    const subIds = subs.map((s) => s.id);

    if (subIds.length === 0) {
      res.json({ items: [] });
      return;
    }

    const where: Record<string, unknown> = {
      subscriptionId: { [Op.in]: subIds },
    };
    if (status === 'unack') {
      where.acknowledgedAt = null;
    }

    const rows = await SubscriptionPriceChange.findAll({
      where,
      order: [['detectedOn', 'DESC']],
    });

    res.json({
      items: rows.map((r) => ({
        id: Number(r.id),
        subscriptionId: Number(r.subscriptionId),
        detectedOn: r.detectedOn,
        previousAmountCents: Number(r.previousAmountCents),
        newAmountCents: Number(r.newAmountCents),
        pctChange: r.pctChange,
        currency: r.currency,
        triggeringTransactionId: r.triggeringTransactionId != null ? Number(r.triggeringTransactionId) : null,
        acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
        acknowledgedByUserId: r.acknowledgedByUserId != null ? Number(r.acknowledgedByUserId) : null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/subscription-price-changes/:id/acknowledge
router.post('/:id/acknowledge', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const id = Number(req.params.id);

    const row = await SubscriptionPriceChange.findByPk(id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Verify the subscription belongs to this household
    const sub = await Subscription.findOne({
      where: { id: row.subscriptionId, ...householdWhere(req) },
    });
    if (!sub) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (row.acknowledgedAt) {
      res.json({
        id: row.id,
        acknowledgedAt: row.acknowledgedAt.toISOString(),
        acknowledgedByUserId: row.acknowledgedByUserId,
      });
      return;
    }

    await row.update({
      acknowledgedAt: new Date(),
      acknowledgedByUserId: auth.user.id,
    });

    res.json({
      id: row.id,
      acknowledgedAt: row.acknowledgedAt!.toISOString(),
      acknowledgedByUserId: row.acknowledgedByUserId,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
