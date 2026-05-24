/**
 * Pure adjusted cost base (ACB) engine for a single security.
 *
 * Canadian CRA-style weighted-average ACB:
 *  - BUY increases position; cost adds at trade amount.
 *  - DRIP (`reinvestment`) is treated as BUY — new shares from a reinvested
 *    dividend add to position and add to total cost.
 *  - SELL removes qty at the prevailing per-unit ACB (NOT FIFO);
 *    proceeds minus removed-cost = realized gain.
 *  - When the position closes (quantity drops to ~0) the per-unit ACB
 *    resets to zero, so the next BUY starts a fresh cost base.
 *  - Other activity types (dividend, interest, fee, etc.) are recorded
 *    in the timeline as no-op events (they don't shift ACB or quantity).
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
      const proceeds = Math.abs(activity.amount);
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
    }
    // All other activity types (dividend, interest, fee, split, transfer,
    // other) are intentionally ignored — they don't shift the
    // weighted-average ACB. We do NOT filter them out of the input (the
    // caller may still want to see them in their stream).
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
