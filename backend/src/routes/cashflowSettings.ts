/**
 * GET / PATCH /api/settings/cashflow — per-user safe-to-spend knobs
 * (issue #199). Row is created on the first PATCH; the GET responds with
 * the user's row (or the bundled defaults) without writing anything.
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { CashflowSettings } from '../models';
import {
  CASHFLOW_SETTINGS_DEFAULTS,
  MIN_SAFE_TO_SPEND_WINDOW_DAYS,
  MAX_SAFE_TO_SPEND_WINDOW_DAYS,
  MIN_COUNTERPARTY_PROMOTION_THRESHOLD,
  MAX_COUNTERPARTY_PROMOTION_THRESHOLD,
} from '../models/CashflowSettings';

const router = Router();

type Serialized = {
  minimumCashBuffer: string;
  safeToSpendWindowDays: number;
  includeCreditCardBalance: boolean;
  includeGoalContributions: boolean;
  counterpartyPromotionThreshold: number;
  excludeNonPartnerInflows: boolean;
};

function serialize(row: InstanceType<typeof CashflowSettings>): Serialized {
  return {
    minimumCashBuffer: String(row.minimumCashBuffer),
    safeToSpendWindowDays: row.safeToSpendWindowDays,
    includeCreditCardBalance: row.includeCreditCardBalance,
    includeGoalContributions: row.includeGoalContributions,
    counterpartyPromotionThreshold: row.counterpartyPromotionThreshold,
    excludeNonPartnerInflows: row.excludeNonPartnerInflows,
  };
}

function defaults(): Serialized {
  return {
    minimumCashBuffer: CASHFLOW_SETTINGS_DEFAULTS.minimumCashBuffer,
    safeToSpendWindowDays: CASHFLOW_SETTINGS_DEFAULTS.safeToSpendWindowDays,
    includeCreditCardBalance: CASHFLOW_SETTINGS_DEFAULTS.includeCreditCardBalance,
    includeGoalContributions: CASHFLOW_SETTINGS_DEFAULTS.includeGoalContributions,
    counterpartyPromotionThreshold:
      CASHFLOW_SETTINGS_DEFAULTS.counterpartyPromotionThreshold,
    excludeNonPartnerInflows: CASHFLOW_SETTINGS_DEFAULTS.excludeNonPartnerInflows,
  };
}

/**
 * Pure validator — exported so unit tests can poke at it without booting
 * the auth + DB stack. Validates each optional field in the patch body,
 * normalises the values for the model layer (money strings fixed at 4
 * decimal places, booleans coerced from common string forms).
 */
export function validateCashflowSettingsPatch(raw: Record<string, unknown>):
  | { ok: true; patch: Partial<Serialized> }
  | { ok: false; error: string } {
  const out: Partial<Serialized> = {};

  if (raw.minimumCashBuffer !== undefined) {
    const n = Number(raw.minimumCashBuffer);
    if (!Number.isFinite(n) || n < 0) {
      return {
        ok: false,
        error: 'minimumCashBuffer must be a non-negative number',
      };
    }
    out.minimumCashBuffer = n.toFixed(4);
  }

  if (raw.safeToSpendWindowDays !== undefined) {
    const n = Number(raw.safeToSpendWindowDays);
    if (
      !Number.isInteger(n) ||
      n < MIN_SAFE_TO_SPEND_WINDOW_DAYS ||
      n > MAX_SAFE_TO_SPEND_WINDOW_DAYS
    ) {
      return {
        ok: false,
        error: `safeToSpendWindowDays must be an integer between ${MIN_SAFE_TO_SPEND_WINDOW_DAYS} and ${MAX_SAFE_TO_SPEND_WINDOW_DAYS}`,
      };
    }
    out.safeToSpendWindowDays = n;
  }

  if (raw.includeCreditCardBalance !== undefined) {
    const b = coerceBool(raw.includeCreditCardBalance);
    if (b === null) {
      return { ok: false, error: 'includeCreditCardBalance must be boolean' };
    }
    out.includeCreditCardBalance = b;
  }

  if (raw.includeGoalContributions !== undefined) {
    const b = coerceBool(raw.includeGoalContributions);
    if (b === null) {
      return { ok: false, error: 'includeGoalContributions must be boolean' };
    }
    out.includeGoalContributions = b;
  }

  if (raw.counterpartyPromotionThreshold !== undefined) {
    const n = Number(raw.counterpartyPromotionThreshold);
    if (
      !Number.isInteger(n) ||
      n < MIN_COUNTERPARTY_PROMOTION_THRESHOLD ||
      n > MAX_COUNTERPARTY_PROMOTION_THRESHOLD
    ) {
      return {
        ok: false,
        error: `counterpartyPromotionThreshold must be an integer between ${MIN_COUNTERPARTY_PROMOTION_THRESHOLD} and ${MAX_COUNTERPARTY_PROMOTION_THRESHOLD}`,
      };
    }
    out.counterpartyPromotionThreshold = n;
  }

  if (raw.excludeNonPartnerInflows !== undefined) {
    const b = coerceBool(raw.excludeNonPartnerInflows);
    if (b === null) {
      return { ok: false, error: 'excludeNonPartnerInflows must be boolean' };
    }
    out.excludeNonPartnerInflows = b;
  }

  return { ok: true, patch: out };
}

function coerceBool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === 'false' || raw === 0 || raw === '0') return false;
  return null;
}

router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const row = await CashflowSettings.findOne({ where: { userId: user.id } });
    res.json(row ? serialize(row) : defaults());
  } catch (e) {
    next(e);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateCashflowSettingsPatch(body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const [row] = await CashflowSettings.findOrCreate({
      where: { userId: user.id },
      defaults: { userId: user.id },
    });
    if (result.patch.minimumCashBuffer !== undefined) {
      row.set('minimumCashBuffer', result.patch.minimumCashBuffer);
    }
    if (result.patch.safeToSpendWindowDays !== undefined) {
      row.set('safeToSpendWindowDays', result.patch.safeToSpendWindowDays);
    }
    if (result.patch.includeCreditCardBalance !== undefined) {
      row.set('includeCreditCardBalance', result.patch.includeCreditCardBalance);
    }
    if (result.patch.includeGoalContributions !== undefined) {
      row.set('includeGoalContributions', result.patch.includeGoalContributions);
    }
    if (result.patch.counterpartyPromotionThreshold !== undefined) {
      row.set(
        'counterpartyPromotionThreshold',
        result.patch.counterpartyPromotionThreshold,
      );
    }
    if (result.patch.excludeNonPartnerInflows !== undefined) {
      row.set('excludeNonPartnerInflows', result.patch.excludeNonPartnerInflows);
    }
    await row.save();
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

export default router;
