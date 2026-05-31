/**
 * Pure adjusted cost base (ACB) engine for a single security.
 *
 * Canadian CRA-style weighted-average ACB:
 *  - BUY increases position; cost adds at trade amount PLUS any commission/fee
 *    on the trade (CRA requires fees to be included in the cost base).
 *  - DRIP (`reinvestment`) is treated as BUY — new shares from a reinvested
 *    dividend add to position and add to total cost.
 *  - SELL removes qty at the prevailing per-unit ACB (NOT FIFO);
 *    net proceeds (gross proceeds MINUS the sell commission/fee) minus
 *    removed-cost = realized gain. Sell fees reduce the gain, not the ACB.
 *    The `proceeds` field on AcbRealizedEvent is the net (after-fee) figure.
 *  - When the position closes (quantity drops to ~0) the per-unit ACB
 *    resets to zero, so the next BUY starts a fresh cost base.
 *  - SPLIT (forward or reverse) preserves totalCost; quantity is
 *    multiplied by `splitRatio` and per-unit ACB is recomputed.
 *  - Return of capital (`return_of_capital`) reduces totalCost (and
 *    per-unit ACB) without changing quantity. ROC that exceeds the cost
 *    base produces an immediate capital gain (CRA s.53(2)(a)(ii)).
 *  - `transfer_in` is buy-like (book cost added). `transfer_out` is
 *    sell-like at current ACB but produces NO realized event — an
 *    in-kind transfer is not a disposition under CRA rules. The
 *    ambiguous bare `transfer` activityType (used for cash CONT-like
 *    rows) stays a no-op.
 *  - Other activity types (dividend, interest, fee, transfer, etc.) are
 *    no-ops in the ACB walk.
 *
 * Currency: inferred from the first activity. A mixed-currency stream
 * emits a warning but math is still in the inferred currency. Callers
 * that span multiple currencies should split first.
 *
 * Tolerance: a 1e-9 epsilon guards against floating-point dust on
 * position-close detection and the "sell exceeds position" check.
 */

/** Input row, projected from an InvestmentActivity. */
export type AcbActivity = {
  id: number;
  tradeDate: string;
  activityType: string;
  quantity: number | null;
  amount: number | null;
  currency: string;
  /** Trade commission / brokerage fee, if any. Added to cost on BUY; subtracted from proceeds on SELL. */
  fees?: number | null;
  /**
   * Stock-split ratio. Required for `activityType === 'split'`. 2 means
   * 2-for-1 (qty doubles, ACB/unit halves). 0.1 means 1-for-10 reverse
   * split. Total cost is preserved across the split.
   */
  splitRatio?: number | null;
  /** For spin_off and merger: fraction of the source security's cost basis
   *  transferred to the recipient security (0..1). */
  costBasisAllocationPct?: number | null;
  /** For merger: cash per share received in addition to the new security. */
  cashComponent?: number | null;
};

/** Position state recorded after each buy/sell event. */
export type AcbLotState = {
  /** Trade date of the activity that produced this state (YYYY-MM-DD). */
  asOf: string;
  /** Running quantity after the event. */
  quantity: number;
  /** Running total cost (always non-negative, 0 when position is closed). */
  totalCost: number;
  /** totalCost / quantity, or 0 when quantity is 0. */
  acbPerUnit: number;
};

/** Recorded for every SELL that resolves against a non-zero position. */
export type AcbRealizedEvent = {
  activityId: number;
  tradeDate: string;
  qtySold: number;
  proceeds: number;
  acbPerUnitAtSale: number;
  costRemoved: number;
  realizedGain: number;
  currency: string;
};

export type AcbResult = {
  finalState: AcbLotState;
  timeline: AcbLotState[];
  realizedEvents: AcbRealizedEvent[];
  realizedTotal: number;
  currency: string;
  warnings: string[];
};

const EPS = 1e-9;

function zeroState(asOf: string): AcbLotState {
  return { asOf, quantity: 0, totalCost: 0, acbPerUnit: 0 };
}

/**
 * Stable sort the input by tradeDate ASC then id ASC. Activities not
 * sorted by the caller are accepted — engine sorts.
 */
function sortActivities(activities: AcbActivity[]): AcbActivity[] {
  return [...activities].sort((a, b) => {
    if (a.tradeDate < b.tradeDate) return -1;
    if (a.tradeDate > b.tradeDate) return 1;
    return a.id - b.id;
  });
}

export function computeAcb(activities: AcbActivity[]): AcbResult {
  const warnings: string[] = [];

  if (activities.length === 0) {
    return {
      finalState: zeroState(''),
      timeline: [],
      realizedEvents: [],
      realizedTotal: 0,
      currency: '',
      warnings,
    };
  }

  const sorted = sortActivities(activities);
  const currency = sorted[0].currency;
  for (const a of sorted) {
    if (a.currency && a.currency !== currency) {
      warnings.push(
        `Mixed currency detected: activity ${a.id} is ${a.currency}, expected ${currency}`
      );
      break;
    }
  }

  let state: AcbLotState = zeroState(sorted[0].tradeDate);
  const timeline: AcbLotState[] = [];
  const realizedEvents: AcbRealizedEvent[] = [];
  let realizedTotal = 0;

  for (const activity of sorted) {
    const type = activity.activityType;
    if (type === 'buy') {
      if (activity.quantity == null || activity.amount == null) {
        warnings.push(
          `BUY activity ${activity.id} on ${activity.tradeDate} missing quantity or amount; ignored`
        );
        continue;
      }
      const qty = activity.quantity;
      const cost = Math.abs(activity.amount) + Math.abs(activity.fees ?? 0);
      const newQuantity = state.quantity + qty;
      const newTotalCost = state.totalCost + cost;
      const newAcb = newQuantity > EPS ? newTotalCost / newQuantity : 0;
      state = {
        asOf: activity.tradeDate,
        quantity: newQuantity,
        totalCost: newTotalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'sell') {
      if (activity.quantity == null || activity.amount == null) {
        warnings.push(
          `SELL activity ${activity.id} on ${activity.tradeDate} missing quantity or amount; ignored`
        );
        continue;
      }
      let qtySold = activity.quantity;
      if (qtySold > state.quantity + EPS) {
        warnings.push(
          `SELL activity ${activity.id} on ${activity.tradeDate}: qty ${qtySold} exceeds position ${state.quantity}; clamped`
        );
        qtySold = state.quantity;
      }
      const proceeds = Math.abs(activity.amount) - Math.abs(activity.fees ?? 0);
      const acbAtSale = state.acbPerUnit;
      const costRemoved = qtySold * acbAtSale;
      const realizedGain = proceeds - costRemoved;
      realizedEvents.push({
        activityId: activity.id,
        tradeDate: activity.tradeDate,
        qtySold,
        proceeds,
        acbPerUnitAtSale: acbAtSale,
        costRemoved,
        realizedGain,
        currency: activity.currency || currency,
      });
      realizedTotal += realizedGain;

      let newQuantity = state.quantity - qtySold;
      let newTotalCost: number;
      let newAcb: number;
      if (newQuantity <= EPS) {
        // Position closed — reset per-unit ACB so the next BUY starts fresh.
        newQuantity = 0;
        newTotalCost = 0;
        newAcb = 0;
        warnings.push(
          `Position closed after activity ${activity.id} on ${activity.tradeDate}; ACB reset`
        );
      } else {
        // Preserve the prevailing per-unit cost across the partial sell.
        newAcb = acbAtSale;
        newTotalCost = newQuantity * newAcb;
      }
      state = {
        asOf: activity.tradeDate,
        quantity: newQuantity,
        totalCost: newTotalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'reinvestment') {
      // DRIP: a cash dividend that was automatically reinvested by buying
      // additional shares of the same security. CRA treats this identically
      // to a BUY — the reinvested amount is added to total cost and the
      // new shares are added to the position.
      if (activity.quantity == null || activity.amount == null) {
        warnings.push(
          `REINVESTMENT activity ${activity.id} on ${activity.tradeDate} missing quantity or amount; ignored`
        );
        continue;
      }
      const qty = activity.quantity;
      const cost = Math.abs(activity.amount);
      const newQuantity = state.quantity + qty;
      const newTotalCost = state.totalCost + cost;
      const newAcb = newQuantity > EPS ? newTotalCost / newQuantity : 0;
      state = {
        asOf: activity.tradeDate,
        quantity: newQuantity,
        totalCost: newTotalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'split') {
      // Stock split (or reverse split). Per CRA, splits are non-taxable
      // and preserve total cost — only quantity and per-unit ACB change.
      // ratio > 1 is a forward split (e.g. 2 = 2-for-1); ratio < 1 is a
      // reverse split (e.g. 0.1 = 1-for-10).
      const ratio = activity.splitRatio;
      if (ratio == null || ratio <= 0 || !Number.isFinite(ratio)) {
        warnings.push(
          `SPLIT activity ${activity.id} on ${activity.tradeDate} missing or invalid splitRatio; ignored`
        );
        continue;
      }
      if (state.quantity <= EPS) {
        warnings.push(
          `SPLIT activity ${activity.id} on ${activity.tradeDate} applied to zero position; ignored`
        );
        continue;
      }
      const newQuantity = state.quantity * ratio;
      const newAcb = newQuantity > EPS ? state.totalCost / newQuantity : 0;
      state = {
        asOf: activity.tradeDate,
        quantity: newQuantity,
        totalCost: state.totalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'return_of_capital') {
      // Return of capital (ROC) reduces ACB without changing quantity.
      // CRA s.53(2)(a)(ii): ROC distributions reduce the unit cost base;
      // if ROC would push ACB below zero, the excess is a deemed
      // immediate capital gain in the year it was paid.
      if (activity.amount == null) {
        warnings.push(
          `ROC activity ${activity.id} on ${activity.tradeDate} missing amount; ignored`
        );
        continue;
      }
      const rocAmount = Math.abs(activity.amount);
      const reduction = Math.min(rocAmount, state.totalCost);
      const immediateGain = rocAmount - reduction;
      const newTotalCost = state.totalCost - reduction;
      const newAcb = state.quantity > EPS ? newTotalCost / state.quantity : 0;
      if (immediateGain > EPS) {
        realizedEvents.push({
          activityId: activity.id,
          tradeDate: activity.tradeDate,
          qtySold: 0,
          proceeds: immediateGain,
          acbPerUnitAtSale: 0,
          costRemoved: 0,
          realizedGain: immediateGain,
          currency: activity.currency || currency,
        });
        realizedTotal += immediateGain;
        warnings.push(
          `ROC activity ${activity.id} on ${activity.tradeDate}: ROC ($${rocAmount}) exceeds cost base ($${state.totalCost.toFixed(2)}); $${immediateGain.toFixed(2)} treated as immediate capital gain`
        );
      }
      state = {
        asOf: activity.tradeDate,
        quantity: state.quantity,
        totalCost: newTotalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'transfer_in') {
      // In-kind transfer in (e.g. DTC delivery from another broker).
      // Treated as a BUY at the supplied book cost — the receiving
      // broker reports ACB on the transfer ticket. When amount is null
      // we fall back to zero-cost (better than crashing) but emit a
      // warning so the caller can manually correct it.
      if (activity.quantity == null) {
        warnings.push(
          `TRANSFER_IN activity ${activity.id} on ${activity.tradeDate} missing quantity; ignored`
        );
        continue;
      }
      const qty = activity.quantity;
      let cost: number;
      if (activity.amount == null) {
        warnings.push(
          `TRANSFER_IN activity ${activity.id} on ${activity.tradeDate} missing amount; treated as zero-cost`
        );
        cost = 0;
      } else {
        cost = Math.abs(activity.amount);
      }
      const newQuantity = state.quantity + qty;
      const newTotalCost = state.totalCost + cost;
      const newAcb = newQuantity > EPS ? newTotalCost / newQuantity : 0;
      state = {
        asOf: activity.tradeDate,
        quantity: newQuantity,
        totalCost: newTotalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'transfer_out') {
      // In-kind transfer out (e.g. DTC delivery to another broker).
      // CRA: this is NOT a disposition — beneficial ownership is
      // preserved across the transfer. We remove quantity at the
      // prevailing ACB but emit NO realized event.
      if (activity.quantity == null) {
        warnings.push(
          `TRANSFER_OUT activity ${activity.id} on ${activity.tradeDate} missing quantity; ignored`
        );
        continue;
      }
      let qty = activity.quantity;
      if (qty > state.quantity + EPS) {
        warnings.push(
          `TRANSFER_OUT activity ${activity.id} on ${activity.tradeDate}: qty ${qty} exceeds position ${state.quantity}; clamped`
        );
        qty = state.quantity;
      }
      const acbAtTransfer = state.acbPerUnit;
      let newQuantity = state.quantity - qty;
      let newTotalCost: number;
      let newAcb: number;
      if (newQuantity <= EPS) {
        newQuantity = 0;
        newTotalCost = 0;
        newAcb = 0;
        warnings.push(
          `Position closed after activity ${activity.id} on ${activity.tradeDate}; ACB reset`
        );
      } else {
        newAcb = acbAtTransfer;
        newTotalCost = newQuantity * newAcb;
      }
      state = {
        asOf: activity.tradeDate,
        quantity: newQuantity,
        totalCost: newTotalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'dividend_in_kind') {
      // Stock dividend (dividend in kind): issuer distributes additional shares.
      // No cash changes hands; new shares increase the position. The total cost
      // basis is unchanged — it is spread across the larger share count, lowering
      // per-unit ACB. CRA: non-taxable; new shares' ACB = old_total_basis / new_total_shares.
      if (activity.quantity == null) {
        warnings.push(
          `DIVIDEND_IN_KIND activity ${activity.id} on ${activity.tradeDate} missing quantity; ignored`
        );
        continue;
      }
      const newQuantity = state.quantity + activity.quantity;
      const newAcb = newQuantity > EPS ? state.totalCost / newQuantity : 0;
      state = {
        asOf: activity.tradeDate,
        quantity: newQuantity,
        totalCost: state.totalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'spin_off') {
      // Spin-off: a portion of the source security's cost basis is reallocated
      // to the recipient security (tracked separately). The source security's
      // quantity is unchanged; only its total cost is reduced by the allocation pct.
      const pct = activity.costBasisAllocationPct ?? 0;
      if (pct <= 0 || pct > 1) {
        warnings.push(
          `SPIN_OFF activity ${activity.id} on ${activity.tradeDate}: costBasisAllocationPct must be in (0,1]; ignored`
        );
        continue;
      }
      const allocated = state.totalCost * pct;
      const newTotalCost = state.totalCost - allocated;
      const newAcb = state.quantity > EPS ? newTotalCost / state.quantity : 0;
      warnings.push(
        `SPIN_OFF activity ${activity.id}: $${allocated.toFixed(2)} of cost basis transferred to recipient security; record a corresponding buy/transfer_in on that security`
      );
      state = {
        asOf: activity.tradeDate,
        quantity: state.quantity,
        totalCost: newTotalCost,
        acbPerUnit: newAcb,
      };
      timeline.push(state);
    } else if (type === 'merger') {
      // Merger/acquisition: the source security's entire position is exchanged for
      // the recipient security (+ optional cash component). The source position
      // closes; its basis (minus cash proceeds) transfers to the recipient.
      // Cash component per share is treated as proceeds and generates a gain/loss.
      const qty = state.quantity;
      const cashPerShare = activity.cashComponent ?? 0;
      const cashProceeds = qty * cashPerShare;
      const basisTransferred = state.totalCost - cashProceeds;
      if (cashProceeds > 0) {
        const gainOnCash = cashProceeds - (state.quantity > EPS ? qty * state.acbPerUnit : 0);
        realizedEvents.push({
          activityId: activity.id,
          tradeDate: activity.tradeDate,
          qtySold: 0,
          proceeds: cashProceeds,
          acbPerUnitAtSale: state.acbPerUnit,
          costRemoved: qty * state.acbPerUnit,
          realizedGain: gainOnCash,
          currency: activity.currency || currency,
        });
        realizedTotal += gainOnCash;
      }
      warnings.push(
        `MERGER activity ${activity.id}: position closed; $${Math.max(0, basisTransferred).toFixed(2)} basis transferred to recipient security; record a corresponding transfer_in on that security`
      );
      state = { asOf: activity.tradeDate, quantity: 0, totalCost: 0, acbPerUnit: 0 };
      timeline.push(state);
    }
    // All other activity types (dividend, interest, fee, ambiguous
    // 'transfer' for cash CONT/withdrawals, other) are intentionally
    // ignored — they don't shift the weighted-average ACB. We do NOT
    // filter them out of the input (the caller may still want to see
    // them in their stream).
  }

  return {
    finalState: state,
    timeline,
    realizedEvents,
    realizedTotal,
    currency,
    warnings,
  };
}
