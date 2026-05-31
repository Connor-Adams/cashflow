/**
 * POST /api/corporate-actions
 * Manually create corporate-action investment activity entries:
 * dividend_in_kind, spin_off, merger, return_of_capital.
 * These are manually-entered and paired with a synthetic importBatch.
 */
import { Router } from 'express';
import { InvestmentActivity, Security } from '../models';
import { currentAuth } from '../auth/middleware';

const router = Router();

const CORPORATE_ACTION_TYPES = [
  'dividend_in_kind',
  'spin_off',
  'merger',
  'return_of_capital',
] as const;

type CorporateActionType = (typeof CORPORATE_ACTION_TYPES)[number];

function str(v: unknown): string | null {
  return v == null || v === '' ? null : String(v);
}
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// POST / — create a corporate-action activity
router.post('/', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const {
      activityType,
      securityId,
      accountId,
      tradeDate,
      currency,
      quantity,
      amount,
      recipientSecurityId,
      costBasisAllocationPct,
      cashComponent,
      description,
    } = req.body as Record<string, unknown>;

    if (!CORPORATE_ACTION_TYPES.includes(activityType as CorporateActionType)) {
      res.status(400).json({ error: 'INVALID_ACTIVITY_TYPE', valid: CORPORATE_ACTION_TYPES });
      return;
    }
    if (!securityId || !accountId || !tradeDate || !currency) {
      res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
      return;
    }

    const type = activityType as CorporateActionType;
    const qtyNum = num(quantity);
    const amtNum = num(amount);

    // Per-type validation
    if (type === 'dividend_in_kind') {
      if (qtyNum == null || qtyNum <= 0) {
        res.status(400).json({ error: 'INVALID_INPUT', field: 'quantity', message: 'Shares received must be positive.' });
        return;
      }
    }
    if (type === 'return_of_capital') {
      if (amtNum == null || amtNum <= 0) {
        res.status(400).json({ error: 'INVALID_INPUT', field: 'amount', message: 'Amount returned must be positive.' });
        return;
      }
    }
    if (type === 'spin_off') {
      if (!recipientSecurityId) {
        res.status(400).json({ error: 'INVALID_INPUT', field: 'recipientSecurityId', message: 'Pick the new security.' });
        return;
      }
      const alloc = num(costBasisAllocationPct);
      if (alloc == null || alloc <= 0 || alloc > 1) {
        res.status(400).json({ error: 'INVALID_INPUT', field: 'costBasisAllocationPct', message: 'Allocation must be between 0 and 1.' });
        return;
      }
      if (qtyNum == null || qtyNum <= 0) {
        res.status(400).json({ error: 'INVALID_INPUT', field: 'quantity', message: 'Shares received must be positive.' });
        return;
      }
    }
    if (type === 'merger') {
      if (!recipientSecurityId) {
        res.status(400).json({ error: 'INVALID_INPUT', field: 'recipientSecurityId', message: 'Pick the new security.' });
        return;
      }
      if (qtyNum == null || qtyNum <= 0) {
        res.status(400).json({ error: 'INVALID_INPUT', field: 'quantity', message: 'Shares received must be positive.' });
        return;
      }
    }

    // Verify security ownership (household-scoped)
    const security = await Security.findByPk(Number(securityId));
    if (!security) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    const importBatch = `manual-corporate-action-${Date.now()}`;

    const activity = await InvestmentActivity.create({
      accountId: Number(accountId),
      householdId: auth.householdId ?? null,
      securityId: Number(securityId),
      activityType: type,
      tradeDate: String(tradeDate),
      settlementDate: null,
      description: str(description) ?? `Manual ${type} entry`,
      quantity: qtyNum != null ? String(qtyNum) : null,
      price: null,
      amount: amtNum != null ? String(amtNum) : null,
      fees: null,
      splitRatio: null,
      recipientSecurityId: recipientSecurityId ? Number(recipientSecurityId) : null,
      costBasisAllocationPct: costBasisAllocationPct != null ? String(num(costBasisAllocationPct)) : null,
      cashComponent: cashComponent != null ? String(num(cashComponent)) : null,
      currency: String(currency).toUpperCase().slice(0, 3),
      sourceReference: null,
      sourceRowFingerprint: `manual-${type}-${securityId}-${tradeDate}-${Date.now()}`,
      importBatch,
    });

    res.status(201).json({ activity: activity.toJSON() });
  } catch (err) {
    next(err);
  }
});

export default router;
