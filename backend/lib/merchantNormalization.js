'use strict';

/**
 * Merchant-string normalization — the single implementation.
 *
 * WHY THIS IS PLAIN CommonJS AND LIVES OUTSIDE `src/`.
 * Two very different loaders need the exact same function:
 *   - the app, as `backend/src/import/normalizeMerchant.ts` (a typed facade
 *     over this file), running compiled from `backend/dist/`;
 *   - Sequelize migrations, which `sequelize-cli` loads as plain JS from
 *     `backend/src/migrations/` with no TypeScript pipeline at all -- in
 *     production `db:migrate` runs before `node dist/server.js`.
 * `backend/lib/` is the one place both can reach with the same relative path:
 * `src/import/` and `dist/import/` sit at the same depth under `backend/`, so
 * `require('../../lib/merchantNormalization')` resolves identically from the
 * source tree and the build output, and `src/migrations/` resolves it the same
 * way. The Dockerfile copies all of `backend/`, so it ships.
 *
 * The alternative -- inlining a copy into the migration, as
 * `20260914000001-backfill-contact-normalized-name.js` does for its two-line
 * normalizer -- is not viable at this size: it is ~120 lines that would drift
 * silently from the live rules. Types for callers live in the sibling
 * `merchantNormalization.d.ts`.
 */

const PROCESSOR_PREFIXES = [
  /^SQ\s*\*\s*/i,
  /^TST\s*\*\s*/i,
  /^PAYPAL\s*\*\s*/i,
  /^STRIPE\s*\*\s*/i,
  /^GOOGLE\s*\*\s*/i,
  /^GOOGLE\s+\*\s*/i,
  /^DD\s*\*\s*/i,
  /^GH\s*\*\s*/i,
  /^IC\s*\*\s*/i,
  /^CTLP\s*\*\s*/i,
  /^INTUIT\s*\*\s*/i,
  /^PADDLE\.NET\s*\*\s*/i,
];

const TRAILING_AMZN_MKTP_ID = /\*[A-Z0-9]{4,}$/;
const TRAILING_STORE_NUMBER = /\s+(#\d+|STORE\s*#?\d+|\d{4,6})$/i;
const TRAILING_PHONE = /\s+\+?\d[\d\-.\s()]{6,}\d$/;

// Strip a mid-string store-id token plus any trailing all-caps city tokens.
// e.g. "#12164 GUELPH", "04747 GUELPH", "C12587 GUELPH", "W1168" (no trailing city).
// Anchored to end of string. Two variants:
//   - Hash/letter-prefixed IDs (#\d{2,} or [A-Z]\d{4,}) match with or without
//     trailing city words — the prefix unambiguously marks a store ID.
//   - Bare numeric IDs (\d{3,}) require at least one trailing all-caps city word;
//     otherwise the existing TRAILING_STORE_NUMBER pass handles them (and we
//     avoid double-stripping cases like "TARGET STORE 5678").
// Subsequent trailing-store-number stripping in the existing while-loop handles
// cases like "WALMART 3144 3144 GUELPH" where one store number remains.
const MID_STORE_WITH_CITY = /\s+(?:(?:#\s*\d{2,}|[A-Z]\d{4,})(?:\s+[A-Z][A-Z'\-]+){0,2}|\d{3,}(?:\s+[A-Z][A-Z'\-]+){1,2})\s*$/;

// US states and Canadian provinces (2-letter codes used in merchant strings)
const STATE_PROV_SET = new Set([
  // Canadian provinces / territories
  'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT',
  // US states
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

// Note: "CA" appears here as Canada; it is also the California state code but
// this ambiguity favours the country interpretation when CA is the tail token.
const COUNTRY_SET = new Set(['US', 'USA', 'CA', 'CAN']);

// All-uppercase word (city name token): 2+ letters, may include apostrophes/hyphens
const ALL_CAPS_WORD = /^[A-Z][A-Z'\-]+$/;

/**
 * Strip trailing city/state/country tokens from a merchant string.
 * Works by scanning backwards through the word list:
 *   1. Skip optional country token (US/CA/...)
 *   2. Skip the state/province 2-letter code
 *   3. Skip up to 2 all-caps city word tokens
 *   4. The remaining words must be non-empty (keep at least 1 word)
 */
function stripCityStateTail(s) {
  const words = s.split(' ');
  let i = words.length - 1;

  // Optional trailing country
  if (i >= 0 && COUNTRY_SET.has(words[i].toUpperCase())) {
    i--;
  }

  // Required state/province code
  if (i < 0 || !STATE_PROV_SET.has(words[i].toUpperCase())) {
    return s; // no state code found — don't strip anything
  }
  i--; // consumed state

  // Optional city words (up to 2), only if all-caps.
  // Require i >= 2 so at least 2 words remain in the merchant name after stripping.
  let cityStripped = 0;
  while (cityStripped < 2 && i >= 2 && ALL_CAPS_WORD.test(words[i])) {
    i--;
    cityStripped++;
  }

  const end = i + 1; // keep words[0..i]

  if (end < 1) return s; // would strip everything — bail out
  return words.slice(0, end).join(' ');
}

/**
 * Collapse a duplicated trailing word, case-insensitively.
 *   "FARM BOY GUELPH GUELPH" -> "FARM BOY GUELPH"
 *   "A&W TORONTO TORONTO"    -> "A&W TORONTO"
 *   "SLAP BURGERS Guelph guelph" -> "SLAP BURGERS Guelph"
 * Only the immediate last two tokens are compared; one duplicate is dropped
 * per call. The surrounding while-loop in `normalizeMerchant` re-applies this
 * (alongside store-number and city/state stripping) until the string stops
 * changing, so chains like "X Y Y Y" collapse over multiple iterations.
 */
function collapseDuplicateTailWord(s) {
  const words = s.split(' ');
  if (
    words.length >= 2 &&
    words[words.length - 1].toLowerCase() === words[words.length - 2].toLowerCase()
  ) {
    words.pop();
    return words.join(' ');
  }
  return s;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

// ---------------------------------------------------------------------------
// Transaction-specific boilerplate.
//
// `merchant_clean` is the key merchant memory (`findMerchantMemory`) and Rule
// patterns hinge on, so anything transaction-specific left in it forks one real
// merchant into many single-support memory buckets — a merchant seen fifteen
// times looks like fifteen merchants seen once and never reaches the support
// threshold that would let memory categorise it for free.
//
// Each pattern below was measured against production before being added; see
// docs/superpowers/specs/2026-09-28-embedding-threshold-calibration.md. They are
// deliberately narrow: bracketed qualifiers, parentheticals and digit groups
// that are NOT of these exact shapes can be part of a merchant's identity and
// are left alone.
// ---------------------------------------------------------------------------

/**
 * Trailing foreign-exchange annotation the card issuer appends to a
 * foreign-currency charge: `[<CURRENCY WORDS> <amount> @ <rate>]`.
 *   "CLOUDFLARE SAN FRANCISCO [UNITED STATES DOLLAR 4.72 @ 1.41314]"
 * The amount and rate differ on every charge, so one monthly subscription
 * becomes one merchant key per month.
 *
 * Anchored to end-of-string and requires the full `<words> <amount> @ <rate>`
 * shape. Every one of the 119 production rows carrying a `[...]` matched this;
 * none carried a bracketed qualifier that was part of the merchant name. A
 * bracket that is not this shape (e.g. `[LIMITED EDITION]`) is preserved.
 */
const FX_RATE_SUFFIX = /\s*\[[A-Z][A-Z ]*\s[\d,]+(?:\.\d+)?\s@\s\d+(?:\.\d+)?\]\s*$/;

/**
 * A parenthetical containing a full ISO date. Wealthsimple stores whole
 * sentences as the merchant, each carrying the execution date:
 *   "Money transfer out of the account (executed at 2026-07-01)"
 * Dropping the parenthetical collapses every month of one activity onto one
 * key. A parenthetical with no ISO date (`BELL CANADA (OB) MONTREAL`) is
 * identity, not boilerplate, and is kept.
 */
const DATE_PARENTHETICAL = /\s*\([^()]*\d{4}-\d{2}-\d{2}[^()]*\)/g;

/**
 * A trailing clause introduced by a date-bearing connective, for the
 * Wealthsimple sentences whose date is not parenthesised:
 *   "... Cash dividend distribution, received on 2024-10-07, record date of"
 *   "Subscription fee paid for period 2026-01-01 to"
 * Everything from the connective (or the bare date) to end-of-string goes. The
 * ISO date is required, so `ACME 2026-09 SUBSCRIPTION` is untouched.
 */
const TRAILING_DATE_CLAUSE =
  /,?\s*(?:received on|record date of|executed at|for period|from|to|on|at)?\s*\d{4}-\d{2}-\d{2}\b.*$/i;

/** Dangling punctuation exposed by removing a trailing clause. */
const DANGLING_TAIL_PUNCTUATION = /[\s,;:]+$/;

/**
 * Card-network transaction-type prefix plus the terminal reference number that
 * follows it:
 *   "CONTACTLESS INTERAC PURCHASE - 8507 SHOPPERS DRUG M" -> "SHOPPERS DRUG M"
 * The reference number is per-transaction, so in production 281 rows carried
 * 241 distinct keys — twelve separate `SHOPPERS DRUG M` merchants, twelve
 * separate `TIM HORTONS`. Stripping it also merges these rows onto the plain
 * credit-card spelling of the same merchant.
 *
 * At least one card-network qualifier is required, so a merchant string that
 * merely starts with `PURCHASE - ` is not touched. Other bank boilerplate
 * (`ONLINE BANKING PAYMENT`, `E-TRANSFER - ...`, `ATM DEPOSIT - ...`,
 * `ONLINE TRANSFER ...`) is deliberately NOT stripped: those carry transfer
 * counterparty and reference information that transfer matching and
 * `detectTypeStage` read, and need their own measurement.
 */
const CARD_NETWORK_PURCHASE_PREFIX =
  /^(?:CONTACTLESS\s+INTERAC|ONLINE\s+BANKING\s+INTERAC|VISA\s+DEBIT|INTERAC)\s+PURCHASE(?:\s+REFUND)?\s*-\s*\d*\s*/i;

/**
 * Remove transaction-specific boilerplate from an already-whitespace-collapsed
 * merchant string. Pure and total: it never throws and never returns a string
 * that is empty when the input was not (a row whose merchant is nothing *but*
 * boilerplate keeps the boilerplate, so it still has something to key on).
 *
 * Exported because migration `20260928000002-renormalize-merchant-clean`
 * mirrors it to re-key historical rows; keep the two in step.
 */
function stripTransactionBoilerplate(input) {
  let s = input;

  const withoutPrefix = s.replace(CARD_NETWORK_PURCHASE_PREFIX, '').trim();
  if (withoutPrefix) s = withoutPrefix;

  const withoutFx = s.replace(FX_RATE_SUFFIX, '').trim();
  if (withoutFx) s = withoutFx;

  const dateStripped = s.replace(DATE_PARENTHETICAL, '').replace(TRAILING_DATE_CLAUSE, '');
  if (dateStripped !== s) {
    // Only tidy the tail when a date clause actually went — otherwise this
    // would silently start rewriting merchants whose stored name happens to
    // end in punctuation, which is not a pattern we measured.
    const cleaned = dateStripped.replace(DANGLING_TAIL_PUNCTUATION, '').trim();
    if (cleaned) s = cleaned;
  }

  return s.replace(/\s+/g, ' ').trim();
}

function normalizeMerchant(raw) {
  if (raw == null) return '';
  const collapsed = decodeHtmlEntities(String(raw)).trim().replace(/\s+/g, ' ');
  if (!collapsed) return '';
  let s = collapsed;

  s = stripTransactionBoilerplate(s);

  for (const re of PROCESSOR_PREFIXES) {
    if (re.test(s)) {
      s = s.replace(re, '').trim();
      break;
    }
  }

  s = s.replace(TRAILING_AMZN_MKTP_ID, '').trim();
  s = s.replace(TRAILING_PHONE, '').trim();
  s = s.replace(MID_STORE_WITH_CITY, '').trim();

  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(TRAILING_STORE_NUMBER, '').trim();
    s = collapseDuplicateTailWord(s);
    s = stripCityStateTail(s);
  }

  const out = s.replace(/\s+/g, ' ').trim();
  // Never hand back nothing when we were given something: an empty
  // `merchant_clean` is a row with no memory key and no rule surface at all.
  return out || collapsed;
}

module.exports = { normalizeMerchant };
