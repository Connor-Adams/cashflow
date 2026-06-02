/**
 * Vendor-specific receipt parsers. Each returns an ExtractedReceiptOrder
 * when the input looks like its vendor's format, or null when the format
 * doesn't match (caller falls back to AI extraction).
 *
 * Bias: a parser SHOULD return null when uncertain. Returning a wrong
 * order is worse than triggering an AI call.
 */
import type { ExtractedReceiptOrder } from '../../ai/extractReceiptItems';
import { parseAppleReceipt } from './apple';
import { parseGoogleReceipt } from './google';
import { parseAmazonReceiptEmail } from './amazon';
import { parseUberRide } from './uber';

export interface ParserContext {
  fromAddress: string | null;
  subject: string | null;
  body: string;
}

export type DeterministicParseResult =
  | { ok: true; parser: string; order: ExtractedReceiptOrder }
  | { ok: false; reason: string };

/**
 * Try each parser in order based on the sender. Returns the first successful
 * parse, or { ok: false } if no parser matched / produced a usable result.
 */
export function tryDeterministicParse(ctx: ParserContext): DeterministicParseResult {
  const from = (ctx.fromAddress ?? '').toLowerCase();

  // Apple
  if (/apple\.com|email\.apple\.com/.test(from)) {
    const order = parseAppleReceipt(ctx.body);
    if (order) return { ok: true, parser: 'apple', order };
    return { ok: false, reason: 'apple_parser_no_match' };
  }
  // Google
  if (/google\.com|googleplay-noreply|payments-noreply|accounts\.google\.com/.test(from)) {
    const order = parseGoogleReceipt(ctx.body);
    if (order) return { ok: true, parser: 'google', order };
    return { ok: false, reason: 'google_parser_no_match' };
  }
  // Amazon (including subsidiaries)
  if (/amazon\.|primevideo\.com|audible\.com/.test(from)) {
    const order = parseAmazonReceiptEmail(ctx.body);
    if (order) return { ok: true, parser: 'amazon', order };
    return { ok: false, reason: 'amazon_parser_no_match' };
  }

  // Uber (rides only; Eats falls through to AI item extraction)
  if (/@?uber\.com/.test(from)) {
    const order = parseUberRide(ctx.body);
    if (order) return { ok: true, parser: 'uber', order };
    return { ok: false, reason: 'uber_parser_no_match' };
  }

  return { ok: false, reason: 'no_vendor_parser' };
}
