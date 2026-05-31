/**
 * GET  /api/activation-state  — returns activation step flags + dismissed cards (#274)
 * POST /api/activation-state/dismiss-card  — append a cardId to dismissed list
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  AiSuggestion,
  BudgetTarget,
  CashflowSettings,
  FinancialGoal,
  HouseholdInvite,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';

const router = Router();

const VALID_CARD_IDS = new Set(['import', 'review', 'budget', 'goal', 'invite']);

router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const hw = householdWhere(req) as { householdId: number };

    const [accounts, unreviewedCount, budgetCount, goalCount, inviteCount, settings] =
      await Promise.all([
        Account.count({ where: hw }),
        AiSuggestion.count({ where: { ...hw, status: 'pending' } }),
        BudgetTarget.count({ where: hw }),
        FinancialGoal.count({ where: hw }),
        HouseholdInvite.count({
          where: { householdId: hw.householdId, createdByUserId: user.id, acceptedAt: { [Op.is]: null as unknown as null } },
        }),
        CashflowSettings.findOne({ where: { userId: user.id } }),
      ]);

    const dismissedCards = (settings?.dismissedActivationCards ?? []) as string[];
    res.json({
      hasAccounts: accounts > 0,
      unreviewedCount,
      hasBudget: budgetCount > 0,
      hasGoal: goalCount > 0,
      hasOutboundInvite: inviteCount > 0,
      dismissedCards,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/dismiss-card', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const { cardId } = (req.body ?? {}) as { cardId?: unknown };
    if (!cardId || typeof cardId !== 'string' || !VALID_CARD_IDS.has(cardId)) {
      res.status(400).json({ error: 'INVALID_CARD' });
      return;
    }
    const [settings] = await CashflowSettings.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
    });
    const existing = (settings.dismissedActivationCards ?? []) as string[];
    if (!existing.includes(cardId)) {
      settings.set('dismissedActivationCards', [...existing, cardId]);
      await settings.save();
    }
    res.json({ ok: true, dismissedCards: settings.dismissedActivationCards });
  } catch (e) {
    next(e);
  }
});

export default router;
