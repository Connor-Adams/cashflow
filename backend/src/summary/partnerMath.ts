export type PartnerNetDirection = 'partner_owes_me' | 'i_owe_partner' | 'even';

/** Pre-aggregated settlement totals for a single (contactId, currency) pair. */
export type SettlementSummary = {
  contactId: number;
  currency: string;
  iPaid: number;
  partnerPaid: number;
};

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
  settlementCount: number;
  net: number;
  direction: PartnerNetDirection;
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
 * This mirrors `queryBuilders.executePartnerBalance`, which already negates and is correct.
 *
 * If multi-payer is ever added (partner uploads from their own account, true joint pool),
 * this is the single place to branch on a real `paid_by` field. `ownershipType` today is
 * stamped from `autoSplitType` at import, so it is not a reliable payer signal.
 */
export function rawNetForRow(r: RawPartnerRow): number {
  // What the partner owes me = the NEGATION of their signed share-sum. Spend is
  // stored negative, so a partner share of a purchase I paid (negative) means the
  // partner owes me that amount (positive); a positive partner share (refund/inflow
  // partly theirs) means I owe them. Mirrors queryBuilders.executePartnerBalance.
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
 * For each row, finds the settlement summary matching (ownershipContactId,
 * currency) and computes:
 *   settledAmount = iPaid - partnerPaid
 *   net (adjusted) = rawNet + settledAmount
 *
 * Rationale: `i_paid_partner` reduces what I owe → adds to net.
 * `partner_paid_me` reduces what partner owes me → subtracts from net.
 *
 * Edge case: rows without an `ownershipContactId` (legacy split with no
 * contact) cannot match a settlement (settlements require a contactId), so
 * they always get `settledAmount=0`, `settlementCount=0`.
 *
 * Orphan settlements — settlement totals with no matching (contact, currency)
 * row — are intentionally dropped, not surfaced as new rows. We do not want
 * to confuse "I paid partner but had no shared spend" with an ongoing
 * balance.
 */
export function applySettlements(
  rows: RawPartnerRow[],
  settlements: SettlementSummary[]
): AdjustedPartnerRow[] {
  const byKey = new Map<string, SettlementSummary>();
  for (const s of settlements) {
    byKey.set(`${s.contactId}\0${s.currency}`, s);
  }
  return rows.map((r) => {
    const rawNet = rawNetForRow(r);
    let settledAmount = 0;
    let settlementCount = 0;
    if (r.ownershipContactId != null) {
      const match = byKey.get(`${r.ownershipContactId}\0${r.currency}`);
      if (match) {
        settledAmount = match.iPaid - match.partnerPaid;
        // Count any settlement that contributed a non-zero side; we surface
        // the count to the UI so "(after N settlements)" is meaningful.
        settlementCount =
          (match.iPaid > 0 ? 1 : 0) + (match.partnerPaid > 0 ? 1 : 0);
      }
    }
    const net = rawNet + settledAmount;
    return {
      ...r,
      rawNet,
      settledAmount,
      settlementCount,
      net,
      direction: directionFromNet(net),
    };
  });
}
