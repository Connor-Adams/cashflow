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
 *      corporate-investing), in either date position — Wealthsimple moved the
 *      date to the end of the name in 2026-08, and both forms are accepted:
 *      <DisplayName>-<YYYY-MM-DD>-monthly-statement-transactions-<wsid>.csv
 *      <DisplayName>-monthly-statement-transactions-<wsid>-<YYYY-MM-DD>.csv
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
const MONTHLY_DATE_INFIX_RE =
  /^(.+?)-(\d{4}-\d{2}-\d{2})-monthly-statement-transactions-([A-Za-z0-9]+CAD?)\.csv$/;

// Wealthsimple moved the period-end date to the END of the name (observed on
// 2026-08 exports): `Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-08-01.csv`.
// Both orderings are accepted — users have archives in the older shape, and
// the two forms cannot collide: the infix pattern needs a date immediately
// before the anchor (absent here) and the suffix pattern needs a trailing
// date after the WSID (absent there).
const MONTHLY_DATE_SUFFIX_RE =
  /^(.+?)-monthly-statement-transactions-([A-Za-z0-9]+CAD?)-(\d{4}-\d{2}-\d{2})\.csv$/;

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
// Wealthsimple's 2026 statement downloads name every product the same way:
// `<WSID>_<identity|corporation>-<opaque token>_<YYYY-MM>_v_<n>.pdf`, e.g.
// `HQ8H0GZ07CAD_corporation-008TfQtMUtWe_2026-08_v_0.pdf`. A trailing
// " (1)" from a repeated browser download is tolerated.
//
// Note the owner segment is NOT a reliable corp/personal signal — an
// `identity-…` file has been observed for a Business chequing account. The
// WSID is what matters; the statement body names the holder.
const STATEMENT_PDF_RE =
  /(?:^|[\/])([A-Za-z0-9]+)_(?:identity|corporation)-[A-Za-z0-9]+_\d{4}-\d{2}_v_\d+(?:\s*\(\d+\))?\.pdf$/i;

/**
 * Extract the stable Wealthsimple account id (WSID) from any WS statement PDF
 * filename — the 2026 convention above, or the older
 * `<WSID>_<YYYY-MM>_CREDIT_CARD.pdf`.
 *
 * This is the only stable account key those files carry: the chequing body
 * prints an internal account number and the credit-card body prints a card
 * last-4, neither of which is what the CSV import path keyed accounts on.
 * Returns null when the name follows neither convention.
 */
export function parseWsPdfWsid(name: string): string | null {
  const modern = STATEMENT_PDF_RE.exec(name);
  if (modern) return modern[1];
  return parseWsCreditCardPdfWsid(name);
}

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

  const infix = name.match(MONTHLY_DATE_INFIX_RE);
  if (infix) {
    return {
      wsid: infix[3],
      productHint: productHintFromDisplayName(infix[1]),
      periodEnd: infix[2],
      isCreditCard: false,
    };
  }

  const suffix = name.match(MONTHLY_DATE_SUFFIX_RE);
  if (suffix) {
    return {
      wsid: suffix[2],
      productHint: productHintFromDisplayName(suffix[1]),
      periodEnd: suffix[3],
      isCreditCard: false,
    };
  }

  return null;
}
