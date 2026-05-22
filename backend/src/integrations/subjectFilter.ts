/**
 * subjectFilter — cheap pre-AI gate that filters out emails whose subjects
 * make it obvious they aren't transactional receipts. Used to avoid burning
 * AI tokens on newsletters and marketing blasts from the same sender that
 * also sometimes mails receipts (e.g. Amazon).
 *
 * Bias: false-positive over false-negative. A questionable subject still
 * passes — better to AI-extract a few wasted emails than to silently drop
 * a real receipt.
 */

const POSITIVE_PATTERNS: RegExp[] = [
  /\breceipt\b/i,
  /\binvoice\b/i,
  /\bbill\b/i,
  /\bpayment\b/i,
  /\bpurchase\b/i,
  /\bcharge(d)?\b/i,
  /\border\b/i,
  /\bconfirmation\b/i,
  /\bconfirmed\b/i,
  /\bshipped\b/i,
  /\bdelivered\b/i,
  /\bsubscription\b/i,
  /\brenewed?\b/i,
  /\bthank\s*you\s*for\s*your\b/i,
  /\byour\s*(amazon|apple|google|order|subscription)/i,
  /\bdonation\b/i,
];

/**
 * Strong negatives are multi-word phrases so specific that they outweigh
 * any incidentally-positive keyword in the subject ("rate your purchase"
 * contains "purchase" but is unambiguously a survey, not a receipt).
 */
const STRONG_NEGATIVE_PATTERNS: RegExp[] = [
  // Survey / review prompts — "Rate your", "Review your", etc.
  /\brate\s*your\b/i,
  /\breview\s*your\b/i,
  /\bthanks?\s*for\s*reviewing\b/i,
  /\bsurvey\b/i,
  // Account-management / policy emails
  /\bpolicy\s*update\b/i,
  /\bterms\s*of\s*service\b/i,
  /\bprivacy\s*policy\b/i,
];

/**
 * Weak negatives — generic marketing keywords. Block only when no positive
 * receipt signal also fires (an actual receipt email occasionally mentions a
 * promo by name).
 */
const WEAK_NEGATIVE_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bnewsletter\b/i,
  /\bweekly\s*(digest|update)\b/i,
  /\bdon't\s*miss\b/i,
  /\blimited\s*time\b/i,
  /\bexclusive\s*deal\b/i,
  /\bfree\s*trial\b/i,
  /\bcoming\s*soon\b/i,
  /\b\d+%\s*off\b/i,
  /\bblack\s*friday\b/i,
  /\bcyber\s*monday\b/i,
  /\bsale\s*ends\b/i,
];

export type SubjectFilterResult =
  | { decision: 'pass'; reason: string }
  | { decision: 'block'; reason: string };

export function classifySubject(subject: string | null | undefined): SubjectFilterResult {
  if (!subject) {
    // No subject at all — bias toward letting it through; AI can still
    // recognise a receipt body even with a blank subject.
    return { decision: 'pass', reason: 'no_subject' };
  }
  const s = subject.trim();
  if (!s) return { decision: 'pass', reason: 'empty_subject' };

  // Strong negatives win unconditionally — surveys / reviews / policy updates
  // are unambiguous even if they contain receipt keywords like "purchase".
  const strongHit = STRONG_NEGATIVE_PATTERNS.find((re) => re.test(s));
  if (strongHit) {
    return { decision: 'block', reason: `strong_negative:${strongHit.source}` };
  }
  const weakHit = WEAK_NEGATIVE_PATTERNS.find((re) => re.test(s));
  const positiveHit = POSITIVE_PATTERNS.find((re) => re.test(s));
  if (weakHit && !positiveHit) {
    return { decision: 'block', reason: `weak_negative:${weakHit.source}` };
  }
  if (positiveHit) {
    return { decision: 'pass', reason: `positive:${positiveHit.source}` };
  }
  // Neither hits — pass-through. AI gets the final say.
  return { decision: 'pass', reason: 'no_match' };
}
