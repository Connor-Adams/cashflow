/**
 * Pure per-activity-type validation for manually entered corporate actions
 * (issue #301). Used by POST /api/portfolio/activities. Kept free of the DB
 * and HTTP layers so it can be unit-tested directly; the route maps an
 * `{ ok: false }` result to a 400 carrying the `code`.
 *
 * Only the four corporate-action types are validated here. Buy/sell/split/
 * DRIP and any other type pass through (those normally arrive via the import
 * pipeline; the endpoint does not gate them).
 */

export type CorporateActionInput = {
  activityType: string;
  quantity?: number | null;
  amount?: number | null;
  recipientSecurityId?: number | null;
  costBasisAllocationPct?: number | null;
  cashComponent?: number | null;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

const OK: ValidationResult = { ok: true };

function isPositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function validateCorporateAction(input: CorporateActionInput): ValidationResult {
  switch (input.activityType) {
    case 'dividend_in_kind':
      if (!isPositive(input.quantity)) {
        return {
          ok: false,
          code: 'DIVIDEND_IN_KIND_REQUIRES_SHARES',
          message: 'Dividend in kind requires a positive number of shares received.',
        };
      }
      return OK;

    case 'spin_off': {
      if (input.recipientSecurityId == null) {
        return {
          ok: false,
          code: 'SPINOFF_REQUIRES_RECIPIENT',
          message: 'Pick the new security.',
        };
      }
      if (!isPositive(input.quantity)) {
        return {
          ok: false,
          code: 'SPINOFF_REQUIRES_SHARES',
          message: 'Spin-off requires a positive number of shares received.',
        };
      }
      const pct = input.costBasisAllocationPct;
      if (pct == null || !Number.isFinite(pct) || pct <= 0 || pct > 1) {
        return {
          ok: false,
          code: 'SPINOFF_ALLOCATION_OUT_OF_RANGE',
          message: 'Allocation must be between 0 and 1.',
        };
      }
      return OK;
    }

    case 'merger':
      if (input.recipientSecurityId == null) {
        return {
          ok: false,
          code: 'MERGER_REQUIRES_RECIPIENT',
          message: 'Pick the new security.',
        };
      }
      if (!isPositive(input.quantity)) {
        return {
          ok: false,
          code: 'MERGER_REQUIRES_SHARES',
          message: 'Merger requires a positive number of shares received.',
        };
      }
      return OK;

    case 'return_of_capital':
      if (!isPositive(input.amount)) {
        return {
          ok: false,
          code: 'ROC_REQUIRES_AMOUNT',
          message: 'Return of capital requires a positive amount.',
        };
      }
      return OK;

    default:
      return OK;
  }
}
