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

/** last4 -> account ids. A last4 shared by two accounts maps to both. */
export function buildLast4Map(
  accounts: { id: number; shortCode: string | null }[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const account of accounts) {
    const last4 = resolveAccountLast4(account.shortCode);
    if (last4 == null) continue;
    const ids = map.get(last4) ?? [];
    ids.push(account.id);
    map.set(last4, ids);
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
