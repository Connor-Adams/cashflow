/**
 * GET / PATCH /api/settings/cashflow — per-user safe-to-spend knobs
 * (issue #199). Row is created on the first PATCH; the GET responds with
 * the user's row (or the bundled defaults) without writing anything.
 *
 * Edited from Settings → Cashflow (and the Partner Fairness toggle).
 */
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { CashflowSettings } from '../models';
import {
  CASHFLOW_SETTINGS_DEFAULTS,
  MAX_MINIMUM_CASH_BUFFER,
  MIN_SAFE_TO_SPEND_WINDOW_DAYS,
  MAX_SAFE_TO_SPEND_WINDOW_DAYS,
  MIN_COUNTERPARTY_PROMOTION_THRESHOLD,
  MAX_COUNTERPARTY_PROMOTION_THRESHOLD,
  MIN_LARGE_PURCHASE_THRESHOLD,
  MAX_LARGE_PURCHASE_THRESHOLD,
  MIN_ASSUMED_ANNUAL_RETURN_RATE,
  MAX_ASSUMED_ANNUAL_RETURN_RATE,
} from '../models/CashflowSettings';

const router = Router();

type Serialized = {
  minimumCashBuffer: string;
  safeToSpendWindowDays: number;
  includeCreditCardBalance: boolean;
  includeGoalContributions: boolean;
  counterpartyPromotionThreshold: number;
  excludeNonPartnerInflows: boolean;
  largePurchaseThreshold: string;
  /** #654 — assumed annual return (decimal string) for the surplus calc. */
  assumedAnnualReturnRate: string;
  /**
   * #259 — ISO8601 timestamp the user dismissed/completed first-run
   * onboarding, or null if they never did. The frontend onboarding gate
   * reads this (combined with active-account count) to decide whether to
   * show the import-creates-accounts wizard. Read-only here; mutated via
   * PATCH /api/preferences/onboarding-dismiss.
   */
  onboardingDismissedAt: string | null;
};

function serialize(row: InstanceType<typeof CashflowSettings>): Serialized {
  return {
    minimumCashBuffer: String(row.minimumCashBuffer),
    safeToSpendWindowDays: row.safeToSpendWindowDays,
    includeCreditCardBalance: row.includeCreditCardBalance,
    includeGoalContributions: row.includeGoalContributions,
    counterpartyPromotionThreshold: row.counterpartyPromotionThreshold,
    excludeNonPartnerInflows: row.excludeNonPartnerInflows,
    largePurchaseThreshold: String(row.largePurchaseThreshold),
    assumedAnnualReturnRate: String(row.assumedAnnualReturnRate),
    onboardingDismissedAt: row.onboardingDismissedAt
      ? new Date(row.onboardingDismissedAt).toISOString()
      : null,
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
    largePurchaseThreshold: CASHFLOW_SETTINGS_DEFAULTS.largePurchaseThreshold,
    assumedAnnualReturnRate: CASHFLOW_SETTINGS_DEFAULTS.assumedAnnualReturnRate,
    onboardingDismissedAt: null,
  };
}

type DecimalField = 'minimumCashBuffer' | 'largePurchaseThreshold' | 'assumedAnnualReturnRate';
type IntegerField = 'safeToSpendWindowDays' | 'counterpartyPromotionThreshold';
type BooleanField =
  | 'includeCreditCardBalance'
  | 'includeGoalContributions'
  | 'excludeNonPartnerInflows';

/** The writable subset of the settings row. */
type CashflowSettingsPatch = Partial<
  Pick<Serialized, DecimalField | IntegerField | BooleanField>
>;

type Range = { min: number; max: number; error: string };

/** Decimal columns — normalised to a 4dp string for DECIMAL(14,4)/(5,4). */
const DECIMAL_FIELDS: Record<DecimalField, Range> = {
  minimumCashBuffer: {
    min: 0,
    max: MAX_MINIMUM_CASH_BUFFER,
    error: `minimumCashBuffer must be a non-negative number no greater than ${MAX_MINIMUM_CASH_BUFFER}`,
  },
  largePurchaseThreshold: {
    min: MIN_LARGE_PURCHASE_THRESHOLD,
    max: MAX_LARGE_PURCHASE_THRESHOLD,
    error: `largePurchaseThreshold must be a number between ${MIN_LARGE_PURCHASE_THRESHOLD} and ${MAX_LARGE_PURCHASE_THRESHOLD}`,
  },
  assumedAnnualReturnRate: {
    min: MIN_ASSUMED_ANNUAL_RETURN_RATE,
    max: MAX_ASSUMED_ANNUAL_RETURN_RATE,
    error: `assumedAnnualReturnRate must be a decimal between ${MIN_ASSUMED_ANNUAL_RETURN_RATE} and ${MAX_ASSUMED_ANNUAL_RETURN_RATE} (e.g. 0.05 for 5%)`,
  },
};

const INTEGER_FIELDS: Record<IntegerField, Range> = {
  safeToSpendWindowDays: {
    min: MIN_SAFE_TO_SPEND_WINDOW_DAYS,
    max: MAX_SAFE_TO_SPEND_WINDOW_DAYS,
    error: `safeToSpendWindowDays must be an integer between ${MIN_SAFE_TO_SPEND_WINDOW_DAYS} and ${MAX_SAFE_TO_SPEND_WINDOW_DAYS}`,
  },
  counterpartyPromotionThreshold: {
    min: MIN_COUNTERPARTY_PROMOTION_THRESHOLD,
    max: MAX_COUNTERPARTY_PROMOTION_THRESHOLD,
    error: `counterpartyPromotionThreshold must be an integer between ${MIN_COUNTERPARTY_PROMOTION_THRESHOLD} and ${MAX_COUNTERPARTY_PROMOTION_THRESHOLD}`,
  },
};

const BOOLEAN_FIELDS: readonly BooleanField[] = [
  'includeCreditCardBalance',
  'includeGoalContributions',
  'excludeNonPartnerInflows',
];

/**
 * Strict numeric parse: a finite number, or a non-blank numeric string.
 * `Number()` alone would turn '', null, true and [] into 0/1, silently
 * writing a zero buffer or disabling large-purchase review.
 */
function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function inRange(n: number | null, range: Range): n is number {
  return n !== null && n >= range.min && n <= range.max;
}

/**
 * Pure validator — exported so unit tests can poke at it without booting
 * the auth + DB stack. Validates each optional field in the patch body,
 * normalises the values for the model layer (money strings fixed at 4
 * decimal places, booleans coerced from common string forms). Unknown
 * fields are ignored.
 */
export function validateCashflowSettingsPatch(raw: Record<string, unknown>):
  | { ok: true; patch: CashflowSettingsPatch }
  | { ok: false; error: string } {
  const out: CashflowSettingsPatch = {};
  const error =
    applyDecimals(raw, out) ?? applyIntegers(raw, out) ?? applyBooleans(raw, out);
  return error ? { ok: false, error } : { ok: true, patch: out };
}

/** Each `apply*` writes its valid fields into `out`; returns the first error. */
function applyDecimals(raw: Record<string, unknown>, out: CashflowSettingsPatch): string | null {
  for (const [field, range] of Object.entries(DECIMAL_FIELDS) as [DecimalField, Range][]) {
    if (raw[field] === undefined) continue;
    const n = toNumber(raw[field]);
    if (!inRange(n, range)) return range.error;
    out[field] = n.toFixed(4);
  }
  return null;
}

function applyIntegers(raw: Record<string, unknown>, out: CashflowSettingsPatch): string | null {
  for (const [field, range] of Object.entries(INTEGER_FIELDS) as [IntegerField, Range][]) {
    if (raw[field] === undefined) continue;
    const n = toNumber(raw[field]);
    if (!inRange(n, range) || !Number.isInteger(n)) return range.error;
    out[field] = n;
  }
  return null;
}

function applyBooleans(raw: Record<string, unknown>, out: CashflowSettingsPatch): string | null {
  for (const field of BOOLEAN_FIELDS) {
    if (raw[field] === undefined) continue;
    const b = coerceBool(raw[field]);
    if (b === null) return `${field} must be boolean`;
    out[field] = b;
  }
  return null;
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
    // The validator only emits known, normalised fields.
    row.set(result.patch);
    await row.save();
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

export default router;
