/**
 * Activation state routes — tracks onboarding progress for the dashboard
 * next-action card deck (issue #274).
 *
 * GET  /api/activation-state        — query activation state in parallel
 * POST /api/activation-state/dismiss-card  — idempotently dismiss a card
 *
 * Mounted at /api/activation-state behind the global requireAuth in app.ts.
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import {
  Account,
  AiSuggestion,
  BudgetTarget,
  CashflowSettings,
  FinancialGoal,
  HouseholdInvite,
} from '../models';

const router = Router();

/** Valid card IDs for #274 */
const VALID_CARD_IDS = ['import', 'review', 'budget', 'goal', 'invite'] as const;
type CardId = (typeof VALID_CARD_IDS)[number];

/**
 * GET /api/activation-state — return activation state for the card deck.
 * Queries run in parallel; any individual failure silently defaults to
 * the "not done" side so cards remain visible rather than disappear.
 */
router.get('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const householdId = household.id;
    const userId = user.id;

    const [
      accountCount,
      unreviewedCount,
      budgetCount,
      goalCount,
      inviteCount,
      settingsRow,
    ] = await Promise.all([
      Account.count({ where: { householdId } }).catch(() => 0),
      AiSuggestion.count({
        where: {
          householdId,
          status: 'suggested',
          kind: { [Op.in]: ['transaction_fields', 'transaction_audit'] },
        },
      }).catch(() => 0),
      BudgetTarget.count({ where: { householdId } }).catch(() => 0),
      FinancialGoal.count({ where: { householdId } }).catch(() => 0),
      HouseholdInvite.count({
        where: {
          householdId,
          createdByUserId: userId,
          acceptedAt: null,
          expiresAt: { [Op.gt]: new Date() },
        },
      }).catch(() => 0),
      CashflowSettings.findOne({ where: { userId } }).catch(() => null),
    ]);

    res.json({
      hasAccounts: accountCount > 0,
      unreviewedCount,
      hasBudget: budgetCount > 0,
      hasGoal: goalCount > 0,
      hasOutboundInvite: inviteCount > 0,
      dismissedCards: settingsRow?.dismissedActivationCards ?? [],
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/activation-state/dismiss-card — idempotently append a card ID
 * to the user's dismissedActivationCards list.
 * Body: { cardId: string }
 * Returns 400 with { error: 'INVALID_CARD' } for unrecognised card IDs.
 */
router.post('/dismiss-card', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const { cardId } = req.body as { cardId?: unknown };

    if (!cardId || !VALID_CARD_IDS.includes(cardId as CardId)) {
      res.status(400).json({ error: 'INVALID_CARD' });
      return;
    }

    const [row] = await CashflowSettings.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
    });

    const current: string[] = row.dismissedActivationCards ?? [];
    if (!current.includes(cardId as string)) {
      row.dismissedActivationCards = [...current, cardId as string];
      await row.save();
    }

    res.json({ dismissedCards: row.dismissedActivationCards });
  } catch (e) {
    next(e);
  }
});

export default router;
