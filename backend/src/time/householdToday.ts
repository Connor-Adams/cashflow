/**
 * Per-household "today" derivation (audit-cleanup wave 3, 2026-06-09 audit).
 *
 * Server-side "today" must reflect the *household's* wall-clock calendar day,
 * not UTC — otherwise overdue/as-of buckets flip at UTC midnight, which is
 * hours early for households in the Americas. The zone lives on the Household
 * primitive (`timezone` column); when unset we fall back to {@link DEFAULT_TIMEZONE}.
 *
 * All conversions go through `Intl.DateTimeFormat` with an explicit `timeZone`,
 * so they are DST-safe (no manual offset arithmetic) and dialect-agnostic.
 */

/** Default zone when a household has no timezone set. Peer of DEFAULT_CURRENCY
 *  ('CAD', see config/env.ts) — the canonical home base. */
export const DEFAULT_TIMEZONE = 'America/Toronto';

/** A YYYY-MM-DD formatter cache, keyed by IANA zone, so we don't reconstruct
 *  an `Intl.DateTimeFormat` on every call. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * The calendar date (YYYY-MM-DD) in `timeZone` for the instant `now`.
 *
 * Uses `en-CA` formatting, which yields `YYYY-MM-DD` directly. If `timeZone`
 * is not a valid IANA zone, falls back to {@link DEFAULT_TIMEZONE} rather than
 * throwing — a bad/typo'd zone must never break a request.
 */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  try {
    return formatterFor(timeZone).format(now);
  } catch {
    return formatterFor(DEFAULT_TIMEZONE).format(now);
  }
}

/** The minimal shape we need off a Household (the model satisfies it). */
export type HasTimezone = { timezone?: string | null };

/**
 * Resolve a household's effective IANA timezone, defaulting to
 * {@link DEFAULT_TIMEZONE} when null / blank / undefined. (An invalid zone is
 * tolerated here and caught later by {@link todayInZone}'s fallback.)
 */
export function resolveHouseholdTimezone(household: HasTimezone | null | undefined): string {
  const tz = household?.timezone;
  if (typeof tz === 'string' && tz.trim() !== '') return tz.trim();
  return DEFAULT_TIMEZONE;
}

/**
 * The household's "today" as YYYY-MM-DD: the calendar date in its configured
 * (or default) zone for the instant `now`. This is the server-side replacement
 * for `new Date().toISOString().slice(0, 10)` on any path that means "the
 * user's today".
 */
export function resolveHouseholdToday(
  household: HasTimezone | null | undefined,
  now: Date = new Date(),
): string {
  return todayInZone(resolveHouseholdTimezone(household), now);
}
