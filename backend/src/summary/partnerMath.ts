import { num } from '../util/numbers';

export type PartnerNetDirection = 'partner_owes_me' | 'i_owe_partner' | 'even';

/** Pre-aggregated settlement totals for a single (contactId, currency) pair. */
export type SettlementSummary = {
  contactId: number;
  currency: string;
  iPaid: number;
  partnerPaid: number;
  /** Number of PartnerSettlement rows folded into this summary. */
  count: number;
};

/** A raw PartnerSettlement row as read from the DB (amount may be a DECIMAL string). */
export type RawSettlementRow = {
  contactId: number;
  currency: string;
  direction: 'i_paid_partner' | 'partner_paid_me';
  amount: unknown;
};

/** Roll raw settlement rows up to one summary per (contactId, currency). */
export function summarizeSettlements(rows: readonly RawSettlementRow[]): SettlementSummary[] {
  const byKey = new Map<string, SettlementSummary>();
  for (const s of rows) {
    const key = `${s.contactId}\0${s.currency}`;
    const acc = byKey.get(key) ?? {
      contactId: s.contactId,
      currency: s.currency,
      iPaid: 0,
      partnerPaid: 0,
      count: 0,
    };
    const amount = num(s.amount) ?? 0;
    if (s.direction === 'i_paid_partner') acc.iPaid += amount;
    else acc.partnerPaid += amount;
    acc.count += 1;
    byKey.set(key, acc);
  }
  return Array.from(byKey.values());
}

/** The lone is_partner contact id, or null when the household has 0 or 2+ partners. */
export function resolveSolePartnerId(partnerContactIds: Iterable<number>): number | null {
  const ids = [...new Set(partnerContactIds)];
  return ids.length === 1 ? ids[0] : null;
}

/**
 * The single rule for "which contact does this split belong to", shared by the
 * Reports partner balance (`applySettlements`) and the Partner Fairness page
 * (`partnerFairness.contactForSharedRow`) so the two can never disagree.
 *
 * - A split stamped with a contact belongs to that contact.
 * - An unstamped split (import historically wrote ownershipType 'partner' /
 *   'shared' with no contact) belongs to the household's sole partner.
 * - With 0 or 2+ partners there is nobody to attribute it to → null.
 * - A 'contact' row with no contact is malformed; never guess the partner.
 *
 * Callers decide what counts as a split (partner share ≠ 0, or a non-'me'
 * ownership type) before asking.
 */
export function attributeSplitContact(
  split: { ownershipType: string; ownershipContactId: number | null },
  solePartnerId: number | null,
): number | null {
  if (split.ownershipContactId != null) return split.ownershipContactId;
  if (split.ownershipType === 'contact') return null;
  return solePartnerId;
}

/** Raw partner-split row, prior to settlement adjustment. */
export type RawPartnerRow = {
  currency: string;
  ownershipType: string;
  ownershipContactId: number | null;
  contactName: string | null;
  sumMy: number | null;
  sumPartner: number | null;
};

/** Adjusted partner-split row returned by `/api/summary/partner`. */
export type AdjustedPartnerRow = RawPartnerRow & {
  rawNet: number;
  settledAmount: number;
  /** Number of settlements applied to this row's (contact, currency). */
  settlementCount: number;
  net: number;
  direction: PartnerNetDirection;
};

/**
 * A settlement total that matched no partner-split row. Surfaced rather than
 * dropped so the UI can say "N settlements could not be matched" instead of
 * showing a balance that silently ignores money that changed hands.
 */
export type UnmatchedSettlement = {
  contactId: number;
  contactName: string | null;
  currency: string;
  iPaid: number;
  partnerPaid: number;
  settledAmount: number;
  settlementCount: number;
};

export type PartnerSettlementResult = {
  byCurrency: AdjustedPartnerRow[];
  unmatchedSettlements: UnmatchedSettlement[];
};

export type PartnerAttribution = {
  /** From `resolveSolePartnerId`; null when the household has 0 or 2+ partners. */
  solePartnerId: number | null;
  /** Contact id → display name, used to label attributed rows. */
  contactNames?: ReadonlyMap<number, string>;
};

/**
 * Per-row "what partner owes me" (signed): positive → partner owes me, negative → I owe partner.
 *
 * Single-payer model: the uploader (me) always pays the transactions. Spend is stored as a
 * NEGATIVE amount (purchase < 0), so `sumPartner` is negative when partner owes me their
 * share of an expense I paid. To convert to "what partner owes me", we negate:
 *   net = −sumPartner
 *
 * Examples:
 *   sumPartner = -100 (partner's share of a purchase) → net = +100 (partner owes me)
 *   sumPartner = +50  (refund/inflow partly theirs)   → net = -50  (I owe partner)
 *
 * sumMy is my own portion (not a debt to anyone) and does NOT enter the net.
 * The AI `partner_balance` answer reaches this through `partnerBalance.loadPartnerBalance`.
 *
 * If multi-payer is ever added (partner uploads from their own account, true joint pool),
 * this is the single place to branch on a real `paid_by` field. `ownershipType` today is
 * stamped from `autoSplitType` at import, so it is not a reliable payer signal.
 */
export function rawNetForRow(r: RawPartnerRow): number {
  // What the partner owes me = the NEGATION of their signed share-sum. Spend is
  // stored negative, so a partner share of a purchase I paid (negative) means the
  // partner owes me that amount (positive); a positive partner share (refund/inflow
  // partly theirs) means I owe them.
  const partner = r.sumPartner ?? 0;
  return partner === 0 ? 0 : -partner;
}

function directionFromNet(net: number): PartnerNetDirection {
  const rounded = Math.round(net * 100) / 100;
  if (rounded > 0) return 'partner_owes_me';
  if (rounded < 0) return 'i_owe_partner';
  return 'even';
}

/**
 * Apply pre-aggregated settlement totals to raw partner rows. Pure function
 * exported so unit tests can exercise the math without spinning up the DB.
 *
 * 1. Each split row is attributed to a contact with `attributeSplitContact`
 *    (the same rule Partner Fairness uses). A row is a split when its
 *    ownership type is not 'me' or it carries a non-zero partner share.
 * 2. Attributed rows are collapsed to ONE row per (contact, currency), so a
 *    settlement — which is per (contact, currency) — is applied exactly once.
 *    Collapsed rows keep the shared ownershipType, or 'mixed' when they differ.
 *    Unattributed rows pass through untouched and never take a settlement.
 * 3. The matching settlement adjusts the row:
 *      settledAmount = iPaid - partnerPaid
 *      net (adjusted) = rawNet + settledAmount
 *    `i_paid_partner` reduces what I owe → adds to net.
 *    `partner_paid_me` reduces what partner owes me → subtracts from net.
 * 4. Settlements that match no row are returned in `unmatchedSettlements`
 *    rather than dropped: they are not turned into balance rows ("I paid my
 *    partner but had no shared spend" is not an ongoing balance), but the UI
 *    must be able to say they exist.
 */
export function applySettlements(
  rows: RawPartnerRow[],
  settlements: SettlementSummary[],
  attribution: PartnerAttribution = { solePartnerId: null },
): PartnerSettlementResult {
  const { solePartnerId, contactNames } = attribution;

  // Collapse attributed rows per (contact, currency); keep the rest as-is.
  const groups = new Map<string, RawPartnerRow>();
  for (const [i, r] of rows.entries()) {
    const isSplit = r.ownershipType !== 'me' || rawNetForRow(r) !== 0;
    const contactId = isSplit ? attributeSplitContact(r, solePartnerId) : null;
    if (contactId == null) {
      groups.set(`row\0${i}`, r);
      continue;
    }
    const key = `${contactId}\0${r.currency}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...r,
        ownershipContactId: contactId,
        contactName: contactNames?.get(contactId) ?? r.contactName,
      });
      continue;
    }
    existing.ownershipType =
      existing.ownershipType === r.ownershipType ? r.ownershipType : 'mixed';
    existing.contactName ??= r.contactName;
    existing.sumMy = addNullable(existing.sumMy, r.sumMy);
    existing.sumPartner = addNullable(existing.sumPartner, r.sumPartner);
  }

  const byKey = new Map<string, SettlementSummary>();
  for (const s of settlements) byKey.set(`${s.contactId}\0${s.currency}`, s);
  const matched = new Set<string>();

  const byCurrency = Array.from(groups.entries(), ([key, r]) => {
    const rawNet = rawNetForRow(r);
    const match = byKey.get(key);
    if (match) matched.add(key);
    const settledAmount = match ? match.iPaid - match.partnerPaid : 0;
    const net = rawNet + settledAmount;
    return {
      ...r,
      rawNet,
      settledAmount,
      settlementCount: match?.count ?? 0,
      net,
      direction: directionFromNet(net),
    };
  });

  const unmatchedSettlements = settlements
    .filter((s) => !matched.has(`${s.contactId}\0${s.currency}`))
    .map((s) => ({
      contactId: s.contactId,
      contactName: contactNames?.get(s.contactId) ?? null,
      currency: s.currency,
      iPaid: s.iPaid,
      partnerPaid: s.partnerPaid,
      settledAmount: s.iPaid - s.partnerPaid,
      settlementCount: s.count,
    }));

  return { byCurrency, unmatchedSettlements };
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}
