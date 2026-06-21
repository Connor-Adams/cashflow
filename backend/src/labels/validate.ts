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

/** A 6-digit hex color, e.g. `#3B82F6`. `null` means "no color → neutral chip". */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export type LabelColorResult =
  | { ok: true; color: string | null }
  | { ok: false; code: 'INVALID_COLOR' };

/**
 * Validates an optional label color (issue #794). The field is optional:
 * `undefined` (not provided) and explicit `null` both mean "no color" and pass.
 * A non-null value must be a 6-digit hex string (`^#[0-9a-fA-F]{6}$`); anything
 * else is `INVALID_COLOR`. The route maps the error to a 400. Empty string is
 * treated as "clear the color" (→ null) for forgiving form submits.
 */
export function validateLabelColor(raw: unknown): LabelColorResult {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, color: null };
  }
  if (typeof raw !== 'string' || !HEX_COLOR.test(raw)) {
    return { ok: false, code: 'INVALID_COLOR' };
  }
  return { ok: true, color: raw };
}
