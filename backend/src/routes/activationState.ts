import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  BudgetTarget,
  CashflowSettings,
  FinancialGoal,
  HouseholdInvite,
  Transaction,
} from '../models';
import { currentAuth } from '../auth/middleware';

const VALID_CARD_IDS = ['import', 'review', 'budget', 'goal', 'invite'] as const;
type CardId = (typeof VALID_CARD_IDS)[number];

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);

    const [accounts, unreviewedCount, budgets, goals, invites, settings] =
      await Promise.all([
        Account.count({ where: { householdId: household.id } }),
        Transaction.count({
          where: { householdId: household.id, reviewFlag: true },
        }),
        BudgetTarget.count({ where: { householdId: household.id } }),
        FinancialGoal.count({ where: { householdId: household.id } }),
        HouseholdInvite.count({
          where: { householdId: household.id, acceptedAt: { [Op.is]: null } },
        }),
        CashflowSettings.findOne({ where: { userId: user.id } }),
      ]);

    const dismissedCards: string[] = settings?.dismissedActivationCards ?? [];

    res.json({
      hasAccounts: accounts > 0,
      unreviewedCount,
      hasBudget: budgets > 0,
      hasGoal: goals > 0,
      hasOutboundInvite: invites > 0,
      dismissedCards,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/dismiss-card', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const { cardId } = req.body as { cardId?: unknown };

    if (!VALID_CARD_IDS.includes(cardId as CardId)) {
      res.status(400).json({ error: 'INVALID_CARD' });
      return;
    }

    const [settings] = await CashflowSettings.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
    });

    const current: string[] = settings.dismissedActivationCards ?? [];
    if (!current.includes(cardId as string)) {
      await settings.update({
        dismissedActivationCards: [...current, cardId as string],
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
