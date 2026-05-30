/**
 * Feedback submission validation (issue #295). Pure — used by the route to
 * reject bad input before any DB work, and unit-tested in isolation.
 *
 * Rules:
 *   - category: one of FEEDBACK_CATEGORIES; missing/empty defaults to 'other';
 *     anything else → INVALID_CATEGORY (AC#3).
 *   - body: 5–2000 chars after trim → BODY_TOO_SHORT / BODY_TOO_LONG (AC#4).
 *   - currentPath / appVersion: optional, trimmed, length-clamped, else null.
 */
export const FEEDBACK_CATEGORIES = ['bug', 'feature', 'confusing', 'other'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const BODY_MIN = 5;
const BODY_MAX = 2000;
const PATH_MAX = 512;
const VERSION_MAX = 64;

export type FeedbackInput = {
  category: FeedbackCategory;
  body: string;
  currentPath: string | null;
  appVersion: string | null;
};

export type ValidationResult =
  | { ok: true; value: FeedbackInput }
  | { ok: false; status: number; error: string };

function cleanOptional(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export function validateFeedback(body: Record<string, unknown>): ValidationResult {
  const rawCategory = body.category;
  let category: FeedbackCategory;
  if (rawCategory == null || rawCategory === '') {
    category = 'other';
  } else if (
    typeof rawCategory === 'string' &&
    (FEEDBACK_CATEGORIES as readonly string[]).includes(rawCategory)
  ) {
    category = rawCategory as FeedbackCategory;
  } else {
    return { ok: false, status: 400, error: 'INVALID_CATEGORY' };
  }

  const rawBody = typeof body.body === 'string' ? body.body : '';
  const trimmedBody = rawBody.trim();
  if (trimmedBody.length < BODY_MIN) {
    return { ok: false, status: 400, error: 'BODY_TOO_SHORT' };
  }
  if (trimmedBody.length > BODY_MAX) {
    return { ok: false, status: 400, error: 'BODY_TOO_LONG' };
  }

  return {
    ok: true,
    value: {
      category,
      body: trimmedBody,
      currentPath: cleanOptional(body.currentPath, PATH_MAX),
      appVersion: cleanOptional(body.appVersion, VERSION_MAX),
    },
  };
}
