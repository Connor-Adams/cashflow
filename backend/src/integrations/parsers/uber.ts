/**
 * Uber receipt parsing. Uber rides and Uber Eats are modeled as two distinct
 * vendors ('uber', 'uber_eats'). The sender address can't distinguish them
 * (both arrive from uber.com), so we classify from the subject/body.
 *
 * Phase 2 adds parseUberRide() for deterministic trip extraction.
 */
import type { ExtractedReceiptOrder, TripDetail } from '../../ai/extractReceiptItems';

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

const RIDE_TOTAL_RE = /\bTotal\b\s*\$?\s*([0-9]+\.[0-9]{2})/i;
const DISTANCE_RE = /([0-9]+(?:\.[0-9]+)?)\s*(km|mi)\b/i;
const DURATION_RE = /([0-9]+)\s*min\b/i;
const TIME_ADDR_RE = /\b\d{1,2}:\d{2}\s*[AP]M\s+(.+?)\s*$/gim;

/** Parse an Uber RIDE email body. Returns null if it doesn't look like a ride. */
export function parseUberRide(body: string): ExtractedReceiptOrder | null {
  if (/uber\s*eats/i.test(body)) return null; // Eats handled by AI extraction
  const totalMatch = body.match(RIDE_TOTAL_RE);
  if (!totalMatch) return null;
  const total = Number(totalMatch[1]);

  const distMatch = body.match(DISTANCE_RE);
  const durMatch = body.match(DURATION_RE);
  const addresses: string[] = [];
  for (const m of body.matchAll(TIME_ADDR_RE)) {
    addresses.push(m[1].trim());
  }

  const trip: TripDetail = {
    pickupAddress: addresses[0] ?? null,
    dropoffAddress: addresses[1] ?? null,
    distance: distMatch ? Number(distMatch[1]) : null,
    distanceUnit: distMatch ? (distMatch[2].toLowerCase() as 'km' | 'mi') : null,
    durationMinutes: durMatch ? Number(durMatch[1]) : null,
    requestedAt: null,
    driver: null,
    surgeMultiplier: null,
  };

  return {
    vendor: 'uber',
    vendorName: 'Uber',
    orderDate: null,
    orderId: null,
    subtotal: null,
    tax: null,
    total,
    currency: null,
    paymentLast4: null,
    tenders: [],
    items: [
      {
        title: 'Uber trip',
        quantity: 1,
        unitPrice: total,
        totalPrice: total,
        inferredCategory: 'Transport',
      },
    ],
    notes: null,
    trip,
  };
}
