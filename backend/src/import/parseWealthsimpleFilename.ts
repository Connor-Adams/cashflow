/**
 * Wealthsimple bundle filename parser.
 *
 * Recognizes two filename patterns produced by Wealthsimple's bulk monthly
 * statement download:
 *
 *   A. Credit card:
 *      Wealthsimple-credit-card-<YYYY-MM-DD>-credit-card-statement-transactions-ca-credit-card-<wsid>.csv
 *
 *   B. Standard monthly (cash, registered, invest, crypto, save-for-business,
 *      corporate-investing):
 *      <DisplayName>-<YYYY-MM-DD>-monthly-statement-transactions-<wsid>.csv
 *
 * The DisplayName segment may contain hyphens AND spaces — e.g.
 * `Corporate investing`, `Corporate-investing`, `Save for business`,
 * `Non-registered-margin`. The product-hint mapping below normalizes by
 * lowercasing and stripping non-alphanumerics before matching.
 *
 * Returns null if neither pattern matches — callers should treat that as an
 * unrecognized file (no auto-route).
 */

export type WsProductHint =
  | 'chequing'
  | 'save_for_business'
  | 'corporate_chequing'
  | 'tfsa'
  | 'fhsa'
  | 'margin'
  | 'corporate_investing'
  | 'crypto'
  | 'credit_card';

export type ParsedWsFilename = {
  wsid: string;
  productHint: WsProductHint;
  periodEnd: string; // YYYY-MM-DD
  isCreditCard: boolean;
};

const CREDIT_CARD_RE =
  /^Wealthsimple-credit-card-(\d{4}-\d{2}-\d{2})-credit-card-statement-transactions-ca-credit-card-([A-Za-z0-9]+)\.csv$/;

// Greedy on the WSID segment so we still match if displayName contains digits
// or extra hyphens. The two `monthly-statement-transactions-` halves around
// the date anchor disambiguate the segments.
const MONTHLY_RE =
  /^(.+?)-(\d{4}-\d{2}-\d{2})-monthly-statement-transactions-([A-Za-z0-9]+CAD?)\.csv$/;

function normalizeDisplayName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function productHintFromDisplayName(raw: string): WsProductHint {
  const norm = normalizeDisplayName(raw);
  // Corporate chequing must match BEFORE the generic chequing check, otherwise
  // "Corporate chequing" normalizes to "corporatechequing" and falls into the
  // personal chequing branch — silently colliding with the personal account
  // template and skipping the corp business-stamp override.
  if (norm.includes('corporate') && norm.includes('chequing')) return 'corporate_chequing';
  if (norm.includes('chequing')) return 'chequing';
  if (norm.includes('saveforbusiness')) return 'save_for_business';
  if (norm === 'tfsa') return 'tfsa';
  if (norm === 'fhsa') return 'fhsa';
  if (norm.includes('corporate')) return 'corporate_investing';
  if (norm.includes('crypto')) return 'crypto';
  if (
    norm.includes('nonregisteredmargin') ||
    norm.includes('invest') ||
    norm.includes('margin')
  ) {
    return 'margin';
  }
  return 'chequing';
}

// WS credit-card PDF statements are stored under the convention
// `<WSID>_<YYYY-MM>_CREDIT_CARD.pdf` (e.g. `C13BRX957CAD_2026-06_CREDIT_CARD.pdf`).
// The statement BODY only prints the card last-4, so the stable WS account id
// (WSID) — the only key that survives across months and matches the WS CSV
// import path — lives solely in this filename prefix.
const CREDIT_CARD_PDF_RE = /(?:^|[\\/])([A-Za-z0-9]+)_\d{4}-\d{2}_CREDIT_CARD\.pdf$/i;

/**
 * Extract the stable WS account id (WSID) from a WS credit-card PDF filename.
 * Returns null if the name does not follow the WS CC PDF convention — callers
 * fall back to the body last-4 in that case.
 */
export function parseWsCreditCardPdfWsid(name: string): string | null {
  const m = CREDIT_CARD_PDF_RE.exec(name);
  return m ? m[1] : null;
}

export function parseWealthsimpleFilename(name: string): ParsedWsFilename | null {
  const cc = name.match(CREDIT_CARD_RE);
  if (cc) {
    return {
      wsid: cc[2],
      productHint: 'credit_card',
      periodEnd: cc[1],
      isCreditCard: true,
    };
  }

  const m = name.match(MONTHLY_RE);
  if (m) {
    return {
      wsid: m[3],
      productHint: productHintFromDisplayName(m[1]),
      periodEnd: m[2],
      isCreditCard: false,
    };
  }

  return null;
}
