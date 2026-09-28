'use strict';

/**
 * Re-keys historical `transactions.merchant_clean` with the boilerplate-aware
 * normalizer added in the same PR (`backend/src/import/normalizeMerchant.ts`),
 * and prunes the recomputable `merchant_embeddings` cache of keys that no
 * longer exist.
 *
 * WHY THIS MIGRATION EXISTS (it is not cosmetic):
 * `merchant_clean` is the key merchant memory (`findMerchantMemory`) and Rule
 * patterns hinge on. Memory is a derived view — a `GROUP BY merchant_clean`
 * over reviewed transactions — so a *code-only* normalization change orphans
 * every existing bucket: memory keyed on
 * `DISCORD* NITROMONTHLY SAN FRANCISCO [UNITED STATES DOLLAR 11.29 @ 1.4349]`
 * becomes unreachable the moment a new import produces
 * `DISCORD* NITROMONTHLY SAN FRANCISCO`, and the new key starts at zero
 * support. Categorisation would get *worse* before it got better. Re-keying the
 * history is what carries the support counts across.
 *
 * MERGE SEMANTICS. Because memory is derived, re-keying merges buckets and
 * their support counts for free: N rows that held N distinct keys (support
 * 1 each) now share one key (support N). Crucially this migration rewrites only
 * `merchant_clean`. No row's `final_category` / `final_business` /
 * `final_split_type` / split percentages are touched, so when two merging
 * buckets DISAGREE on the categorisation, both labels survive on their own
 * rows and the disagreement stays visible (the Wealthsimple transfer sentences
 * are labelled `Transfer` some months and `Investments` others). The winner is
 * then resolved at read time by `findMerchantMemory`, deterministically:
 * highest support count, then most recent `reviewed_at`, then category name —
 * never by insertion order.
 *
 * WHAT IT DOES *NOT* DO:
 *   - It does not recompute `merchant_canonical`. That is a brand lookup owned
 *     by the enrichment normalize stage; a stale canonical is no worse than
 *     before, and `runEnrichmentBackfill` re-derives it.
 *   - It does not rewrite `merchant_raw`, which stays the untouched source of
 *     truth (and is what `detectTypeStage` reads alongside `merchant_clean`).
 *   - It does not touch Rules. Measured against production: of 59 rule
 *     patterns, zero rows lose a match and zero gain one.
 *
 * The normalizer is INLINED below rather than imported. Migrations must be
 * frozen at the semantics of their moment — `sequelize-cli` loads plain JS with
 * no TS pipeline, and a migration that tracked a live module would silently
 * change meaning on every later normalizer edit. Mirrors
 * `backend/src/import/normalizeMerchant.ts` as of 2026-09-28; if that file
 * changes, this one deliberately does not.
 */

// --- BEGIN inlined mirror of src/import/normalizeMerchant.ts (2026-09-28) ---

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
const MID_STORE_WITH_CITY =
  /\s+(?:(?:#\s*\d{2,}|[A-Z]\d{4,})(?:\s+[A-Z][A-Z'\-]+){0,2}|\d{3,}(?:\s+[A-Z][A-Z'\-]+){1,2})\s*$/;

const FX_RATE_SUFFIX = /\s*\[[A-Z][A-Z ]*\s[\d,]+(?:\.\d+)?\s@\s\d+(?:\.\d+)?\]\s*$/;
const DATE_PARENTHETICAL = /\s*\([^()]*\d{4}-\d{2}-\d{2}[^()]*\)/g;
const TRAILING_DATE_CLAUSE =
  /,?\s*(?:received on|record date of|executed at|for period|from|to|on|at)?\s*\d{4}-\d{2}-\d{2}\b.*$/i;
const DANGLING_TAIL_PUNCTUATION = /[\s,;:]+$/;
const CARD_NETWORK_PURCHASE_PREFIX =
  /^(?:CONTACTLESS\s+INTERAC|ONLINE\s+BANKING\s+INTERAC|VISA\s+DEBIT|INTERAC)\s+PURCHASE(?:\s+REFUND)?\s*-\s*\d*\s*/i;

const STATE_PROV_SET = new Set([
  'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT',
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);
const COUNTRY_SET = new Set(['US', 'USA', 'CA', 'CAN']);
const ALL_CAPS_WORD = /^[A-Z][A-Z'\-]+$/;

function stripCityStateTail(s) {
  const words = s.split(' ');
  let i = words.length - 1;
  if (i >= 0 && COUNTRY_SET.has(words[i].toUpperCase())) i--;
  if (i < 0 || !STATE_PROV_SET.has(words[i].toUpperCase())) return s;
  i--;
  let cityStripped = 0;
  while (cityStripped < 2 && i >= 2 && ALL_CAPS_WORD.test(words[i])) {
    i--;
    cityStripped++;
  }
  const end = i + 1;
  if (end < 1) return s;
  return words.slice(0, end).join(' ');
}

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
  return s.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

function stripTransactionBoilerplate(input) {
  let s = input;

  const withoutPrefix = s.replace(CARD_NETWORK_PURCHASE_PREFIX, '').trim();
  if (withoutPrefix) s = withoutPrefix;

  const withoutFx = s.replace(FX_RATE_SUFFIX, '').trim();
  if (withoutFx) s = withoutFx;

  const dateStripped = s.replace(DATE_PARENTHETICAL, '').replace(TRAILING_DATE_CLAUSE, '');
  if (dateStripped !== s) {
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
  return out || collapsed;
}

// --- END inlined mirror ---

const BATCH = 500;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT id, merchant_clean FROM transactions
          WHERE merchant_clean IS NOT NULL AND merchant_clean != ''
          ORDER BY id ASC`,
        { transaction },
      );

      const changes = [];
      for (const row of rows) {
        const next = normalizeMerchant(row.merchant_clean);
        // A normalization that produced nothing is a bug, not an improvement:
        // an empty merchant_clean is a row with no memory key and no rule
        // surface. Skip it rather than degrade the row.
        if (!next || next === row.merchant_clean) continue;
        changes.push({ id: row.id, merchantClean: next });
      }

      for (let i = 0; i < changes.length; i += BATCH) {
        const slice = changes.slice(i, i + BATCH);
        // One UPDATE per row: the values are arbitrary text and the row count
        // here is in the low thousands, so a CASE-folded bulk statement buys
        // nothing and costs readability.
        for (const c of slice) {
          await queryInterface.sequelize.query(
            'UPDATE transactions SET merchant_clean = :mc WHERE id = :id',
            { replacements: { mc: c.merchantClean, id: c.id }, transaction },
          );
        }
      }

      // merchant_embeddings is a pure memoization cache keyed on
      // merchant_clean (one vector per distinct key per model) and is fully
      // recomputable. Re-keying invalidates any entry whose key no longer
      // appears on a transaction, so drop those rather than leave vectors
      // nothing can ever hit again.
      await queryInterface.sequelize.query(
        `DELETE FROM merchant_embeddings
          WHERE merchant_clean NOT IN (
            SELECT merchant_clean FROM transactions
             WHERE merchant_clean IS NOT NULL AND merchant_clean != ''
          )`,
        { transaction },
      );
    });
  },

  async down() {
    // No-op, deliberately. The pre-migration values were boilerplate-laden
    // keys — an FX rate, an execution date or a terminal reference number per
    // transaction — and they are not recoverable from the schema: the
    // re-keying is many-to-one, so there is no way to tell which of the
    // thirteen `BT*IRACING ... [USD 1.35 @ <rate>]` spellings a given row had.
    // Restoring them would also re-fragment every merchant-memory bucket this
    // migration merged, which is the exact harm it exists to prevent.
    //
    // To genuinely revert: check out the prior `normalizeMerchant` and run
    // `runEnrichmentBackfill`, which re-derives merchant_clean from the
    // untouched `merchant_raw`.
  },
};
