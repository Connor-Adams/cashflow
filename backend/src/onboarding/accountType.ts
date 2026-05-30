/**
 * Account-type vocabulary for the first-run onboarding wizard (#259).
 *
 * The issue's API contract advertises the enum
 * `'checking' | 'savings' | 'credit' | 'investment' | 'other'` to the
 * frontend, but the persisted `accounts.account_type` column uses
 * `credit_card` (not `credit`) — see backend/src/routes/accounts.ts. This
 * module is the single normalization point so the wizard, the route
 * validator, and the inference helper all agree.
 */

/** The values the onboarding API accepts from the client (issue contract). */
export const ONBOARDING_ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit',
  'investment',
  'other',
] as const;

export type OnboardingAccountType = (typeof ONBOARDING_ACCOUNT_TYPES)[number];

export function isOnboardingAccountType(
  value: unknown,
): value is OnboardingAccountType {
  return (
    typeof value === 'string' &&
    (ONBOARDING_ACCOUNT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Maps the client-facing onboarding type to the persisted
 * `accounts.account_type` value. Only `credit -> credit_card` differs; the
 * rest pass through unchanged (and are all members of the accounts route's
 * accepted set: checking|savings|credit_card|investment|other).
 */
export function toAccountColumnType(type: OnboardingAccountType): string {
  return type === 'credit' ? 'credit_card' : type;
}
