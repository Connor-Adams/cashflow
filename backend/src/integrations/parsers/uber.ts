/**
 * Uber receipt parsing. Uber rides and Uber Eats are modeled as two distinct
 * vendors ('uber', 'uber_eats'). The sender address can't distinguish them
 * (both arrive from uber.com), so we classify from the subject/body.
 *
 * Phase 2 adds parseUberRide() for deterministic trip extraction.
 */

/** Classify an Uber email as a ride ('uber') or an Eats order ('uber_eats'). */
export function classifyUberKind(subject: string | null, body: string): 'uber' | 'uber_eats' {
  const hay = `${subject ?? ''} ${body}`;
  return /uber\s*eats/i.test(hay) ? 'uber_eats' : 'uber';
}

/**
 * Returns the Uber vendor to force on an extracted order, or null when the
 * message isn't from an Uber sender. The Gmail query already restricts senders
 * to the allowlist, so an @uber.com From is authoritative.
 */
export function uberVendorOverride(
  fromAddress: string | null,
  subject: string | null,
  body: string,
): 'uber' | 'uber_eats' | null {
  if (!/@uber\.com/i.test(fromAddress ?? '')) return null;
  return classifyUberKind(subject, body);
}
