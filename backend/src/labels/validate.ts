/**
 * Pure validation for label names (issue #270). Extracted from the route
 * handlers so it can be unit-tested without a database. The route layer is the
 * authoritative gate for length (AC #3) and case-insensitive uniqueness (AC #2,
 * enforced together with the DB functional unique index).
 */

export const LABEL_NAME_MAX = 32;

export type LabelNameResult =
  | { ok: true; name: string }
  | { ok: false; code: 'INVALID_LABEL_NAME' };

/**
 * Trims the input and validates it as a label name: must be a string, 1..32
 * characters after trimming. Returns the normalized (trimmed) name on success,
 * or an error code the route maps to a 400.
 */
export function validateLabelName(raw: unknown): LabelNameResult {
  if (typeof raw !== 'string') return { ok: false, code: 'INVALID_LABEL_NAME' };
  const name = raw.trim();
  if (name.length === 0 || name.length > LABEL_NAME_MAX) {
    return { ok: false, code: 'INVALID_LABEL_NAME' };
  }
  return { ok: true, name };
}
