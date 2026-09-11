/**
 * Resolve which Cashflow account a card last-4 belongs to.
 *
 * `accounts.bank_account_number` is empty on every account, so `short_code` is
 * the sole card identifier — and it holds the last4 as a SUFFIX in three
 * incompatible formats: Amex writes 6 digits ('701001' -> 1001), RBC and Wise
 * write the bare 4 ('5234'), and Wealthsimple writes an opaque alphanumeric
 * account id ('HQ6LMLTK8CAD') that carries no card number at all.
 *
 * Two consumers:
 *   - the Amazon matcher, where this replaces a dead text-scrape of
 *     txn.notes/sourceReference (0 hits across 111 production transactions);
 *   - foreign-card exclusion, where 291 of 538 orders carry a last4 belonging
 *     to no account.
 *
 * Pure: takes plain objects, never model instances, so it is trivially testable.
 */
export type CardOwnership = 'known' | 'foreign' | 'unknown';

/** The card last-4 an account's short code encodes, or null when it encodes none. */
export function resolveAccountLast4(shortCode: string | null): string | null {
  if (shortCode == null) return null;
  const trimmed = shortCode.trim();
  if (!/^\d{4,}$/.test(trimmed)) return null;
  return trimmed.slice(-4);
}

/**
 * ALL last-4s known for one account (docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md,
 * Part 4): the harvested `account_card_identifiers` rows UNION the
 * short_code-derived value.
 *
 * The short_code fallback is load-bearing, not legacy cruft: Amex Reserve
 * (`701001` -> `1001`) and Amex Cobalt (`741005` -> `1005`) have 71 PDF
 * imports between them whose filenames are date-only, so they will NEVER
 * gain an identifier row from harvesting. Their last-4s must keep coming
 * from short_code parsing exactly as before -- dropping this fallback would
 * silently break the only two accounts that currently work.
 */
export function resolveAccountLast4s(
  shortCode: string | null,
  identifierLast4s: readonly string[] = [],
): string[] {
  const set = new Set(identifierLast4s);
  const fromShortCode = resolveAccountLast4(shortCode);
  if (fromShortCode != null) set.add(fromShortCode);
  return Array.from(set);
}

/**
 * last4 -> account ids. A last4 shared by two accounts maps to both.
 *
 * `identifierLast4s` is optional and additive only: every existing caller
 * that still passes bare `{ id, shortCode }` objects behaves exactly as
 * before. Callers that also want harvested `account_card_identifiers` rows
 * folded in should load them ONCE per request (never per account -- this is
 * a hot dashboard/budget path) and attach them here.
 */
export function buildLast4Map(
  accounts: { id: number; shortCode: string | null; identifierLast4s?: string[] }[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const account of accounts) {
    for (const last4 of resolveAccountLast4s(account.shortCode, account.identifierLast4s ?? [])) {
      const ids = map.get(last4) ?? [];
      ids.push(account.id);
      map.set(last4, ids);
    }
  }
  return map;
}

/**
 * `unknown` is deliberately NOT `foreign`: absence of a last4 is not evidence of
 * a foreign card. 135 of 538 production orders have no last4 and most are the
 * user's own, so they stay matchable and counted — just badged.
 */
export function classifyCardOwnership(
  paymentLast4: string | null,
  map: Map<string, number[]>,
): CardOwnership {
  if (paymentLast4 == null || paymentLast4 === '') return 'unknown';
  return map.has(paymentLast4) ? 'known' : 'foreign';
}

/**
 * `classifyCardOwnership`, scoped to the vendor guard that governs the
 * foreign-card exclusion (backend/src/summary/loadItemAllocations.ts,
 * commit 8b56596a; backend/src/routes/items.ts, commit cc1672dc): only
 * vendor 'amazon' may ever be classified 'foreign'. Production has zero
 * accepted Amazon links but 7 accepted non-Amazon links (6 costco, 1
 * uber_eats), and a vendor-agnostic rule misclassified 5 of those 7 because
 * an opaque short_code (e.g. Costco's 'costco') derives no last4 even though
 * the order's own last4 is real.
 *
 * Every DTO/serializer that surfaces `cardOwnership` (never a table column —
 * always derived at request time) should call this rather than
 * `classifyCardOwnership` directly, so the vendor guard cannot drift between
 * call sites.
 */
export function classifyCardOwnershipForVendor(
  vendor: string,
  paymentLast4: string | null,
  map: Map<string, number[]>,
): CardOwnership {
  const raw = classifyCardOwnership(paymentLast4, map);
  return raw === 'foreign' && vendor !== 'amazon' ? 'known' : raw;
}

/**
 * `classifyCardOwnershipForVendor`, further scoped to the derivable-account
 * guard (backend/src/summary/loadItemAllocations.ts guard 2;
 * backend/src/routes/items.ts `foreignOrderIds`): a raw 'foreign' result is
 * not shown as foreign when the account backing whatever attribution reached
 * this order (an accepted TransactionOrderLink, or a receipt's own
 * transaction) has no derivable last4 -- there is no basis for the
 * comparison. `unknown` is the honest result here, NOT `known`: the order's
 * own last4 genuinely matches no account, so it is being counted on benefit
 * of the doubt, not because the card was verified (task 15 finding 2).
 *
 * `linkedAccountShortCode` is:
 *   - a `string | null` -- the short_code of the account the order is
 *     actually attributed through, so the guard can be evaluated; or
 *   - `undefined` -- there is no such account to consult (no attribution),
 *     so the guard cannot apply and the raw classification stands.
 *
 * Used by backend/src/routes/receipts.ts, which (unlike items.ts) does not
 * pre-filter foreign orders out of its result set, so it cannot rely on
 * items.ts's "any residual foreign in a surviving row must be the guard
 * case" shortcut and must check the actual linked account.
 *
 * NOTE: The Items page (items.ts) and receipts drawer (receipts.ts) can
 * disagree on cardOwnership for a multi-link order spanning derivable and
 * opaque accounts: items.ts saves the order from exclusion if ANY link has
 * an opaque account (no basis for comparison), then clamps any residual
 * 'foreign' to 'unknown'. But receipts.ts checks the specific account
 * behind each receipt independently. A multi-link order can therefore show
 * 'unknown' on Items and 'foreign' on Receipts when the receipt is attached
 * to a derivable account. This is a known limitation and cosmetic only
 * (both endpoints count the item; only the badge differs). See
 * backend/src/routes/cardOwnershipConsistency.test.ts for a regression test.
 */
export function classifyCardOwnershipForDisplay(
  vendor: string,
  paymentLast4: string | null,
  map: Map<string, number[]>,
  linkedAccountShortCode: string | null | undefined,
): CardOwnership {
  const raw = classifyCardOwnershipForVendor(vendor, paymentLast4, map);
  if (raw !== 'foreign') return raw;
  if (linkedAccountShortCode === undefined) return raw;
  return resolveAccountLast4(linkedAccountShortCode) == null ? 'unknown' : raw;
}

/**
 * `ExternalOrder.source` strings trusted to harvest an `account_card_identifiers`
 * row from a receipt tender's `paymentLast4`
 * (docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md, Part 2 —
 * used by backend/src/import/matchReceiptToTransactions.ts).
 *
 * An EXPLICIT allowlist of exact source strings, not a denylist and not a
 * "doesn't look like AI" heuristic. Production has exactly one known bad
 * datum: `gmail-scan:ai` wrote a `9907` last-4 onto Amex Reserve that was
 * actually an AI misparse of a non-card number on an Uber Eats receipt,
 * while `costco_till_receipt-pdf` wrote a correct `3114` (corroborated by 4
 * accepted links + 29 more orders). A pattern like "reject anything
 * containing 'ai'" is one future parser id away from silently trusting the
 * next misparse; an explicit list only grows when someone deliberately adds
 * to it.
 *
 * Every entry here names a parser that reads a card number out of already-
 * structured text via a plain regex — never an LLM:
 *   - `costco_till_receipt-pdf` — backend/src/import/pdf/receipts/costcoTillReceipt.ts,
 *     registered under id `costco_till_receipt`
 *     (backend/src/import/pdf/receipts/registry.ts), reached through the
 *     direct receipt-PDF-upload route (`${parser.id}-pdf` in
 *     backend/src/routes/externalOrders.ts).
 *   - `gmail-scan:<parser>` / `gmail-scan:<parser>-pdf` and the
 *     `gmail-discovery:` equivalents — backend/src/integrations/scanReceipts.ts
 *     and discoverReceiptSources.ts stamp these when
 *     `tryDeterministicParse` (backend/src/integrations/parsers/index.ts)
 *     matched one of its regex-based vendor parsers (`apple`, `google`,
 *     `amazon`, `uber`) with NO AI fallback involved.
 *
 * Deliberately excluded:
 *   - `gmail-scan:ai` / `gmail-discovery:ai` (and any `-pdf` variant) — no
 *     deterministic parser matched; the LLM extracted everything.
 *   - `gmail-scan:<parser>+ai` / `gmail-discovery:<parser>+ai` — the
 *     deterministic parser came back incomplete and AI filled the rest; the
 *     last-4 field itself is not provably the deterministic parser's.
 *   - `email-paste` and `image-upload` — both go through AI extraction
 *     (backend/src/ai/extractReceiptItems.ts) on arbitrary pasted/uploaded
 *     content, never a named vendor parser.
 *   - `${vendor}-csv` — CSV-derived orders don't reach this harvest hook
 *     today; add explicitly if that changes.
 */
export const DETERMINISTIC_RECEIPT_SOURCES: ReadonlySet<string> = new Set([
  'costco_till_receipt-pdf',
  'gmail-scan:apple',
  'gmail-scan:apple-pdf',
  'gmail-scan:google',
  'gmail-scan:google-pdf',
  'gmail-scan:amazon',
  'gmail-scan:amazon-pdf',
  'gmail-scan:uber',
  'gmail-scan:uber-pdf',
  'gmail-discovery:apple',
  'gmail-discovery:apple-pdf',
  'gmail-discovery:google',
  'gmail-discovery:google-pdf',
  'gmail-discovery:amazon',
  'gmail-discovery:amazon-pdf',
  'gmail-discovery:uber',
  'gmail-discovery:uber-pdf',
]);

/** Whether an ExternalOrder.source is trusted to harvest a card identifier from. */
export function isDeterministicReceiptSource(source: string | null | undefined): boolean {
  return source != null && DETERMINISTIC_RECEIPT_SOURCES.has(source);
}
