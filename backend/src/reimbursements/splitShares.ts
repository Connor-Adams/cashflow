/**
 * Pure share-math + request validation for the multiway transaction split.
 * No I/O — DB-touching checks (contact-in-household, is_self) live in the route.
 *
 * Semantics: the payer ("me") fronts the outlay; each *other* participant owes
 * a share back (one Reimbursement claim each). "me" never gets a claim — the
 * remainder is `selfAmount`. Amounts round to 2 decimals, stored fixed-4.
 */

export type SplitMethod = 'even' | 'percent';

export interface SplitParticipantInput {
  contactId: number;
  pct?: number;
}

export interface SplitShare {
  contactId: number;
  /** Positive fixed-4 string. */
  amount: string;
}

export interface ComputedSplit {
  shares: SplitShare[];
  /** The payer's remainder (fixed-4). '0.0000' when self is excluded. */
  selfAmount: string;
}

export interface ValidSplitRequest {
  method: SplitMethod;
  participants: SplitParticipantInput[];
  includeSelf: boolean;
}

export type SplitValidation =
  | { ok: true; value: ValidSplitRequest }
  | { ok: false; status: number; error: string };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeSplitShares(
  totalAbs: string | number,
  method: SplitMethod,
  participants: SplitParticipantInput[],
  includeSelf: boolean,
): ComputedSplit {
  const total = Math.abs(Number(totalAbs)) || 0;
  const shares: SplitShare[] = [];

  if (method === 'even') {
    const n = participants.length + (includeSelf ? 1 : 0);
    for (const p of participants) {
      shares.push({ contactId: p.contactId, amount: round2(total / n).toFixed(4) });
    }
  } else {
    for (const p of participants) {
      const pct = Number(p.pct ?? 0);
      shares.push({ contactId: p.contactId, amount: round2((total * pct) / 100).toFixed(4) });
    }
  }

  const sumShares = shares.reduce((a, s) => a + Number(s.amount), 0);
  const selfExcluded =
    (method === 'even' && !includeSelf) ||
    (method === 'percent' && 100 - participants.reduce((a, p) => a + Number(p.pct ?? 0), 0) <= 0);

  let selfAmount = '0.0000';
  if (selfExcluded) {
    // Residual cents go to the last participant so the shares sum to the total.
    const residual = round2(total - sumShares);
    if (shares.length > 0 && residual !== 0) {
      const last = shares[shares.length - 1];
      last.amount = round2(Number(last.amount) + residual).toFixed(4);
    }
  } else {
    selfAmount = round2(total - sumShares).toFixed(4);
  }

  return { shares, selfAmount };
}

export function validateSplitRequest(raw: Record<string, unknown>): SplitValidation {
  const method = raw.method;
  if (method !== 'even' && method !== 'percent') {
    return { ok: false, status: 400, error: "method must be 'even' or 'percent'" };
  }
  const includeSelf = raw.includeSelf === false ? false : true;

  if (!Array.isArray(raw.participants) || raw.participants.length === 0) {
    return { ok: false, status: 400, error: 'participants must be a non-empty array' };
  }

  const participants: SplitParticipantInput[] = [];
  const seen = new Set<number>();
  let pctSum = 0;
  for (const entry of raw.participants as unknown[]) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = Number(e.contactId);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, status: 400, error: 'each participant needs a positive integer contactId' };
    }
    if (seen.has(id)) {
      return { ok: false, status: 400, error: `duplicate contactId ${id}` };
    }
    seen.add(id);
    const p: SplitParticipantInput = { contactId: id };
    if (method === 'percent') {
      const pct = Number(e.pct);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return { ok: false, status: 400, error: 'each percent must be a number in (0, 100]' };
      }
      p.pct = pct;
      pctSum += pct;
    }
    participants.push(p);
  }

  if (method === 'percent' && pctSum > 100 + 1e-9) {
    return { ok: false, status: 400, error: 'percentages must sum to at most 100' };
  }

  return { ok: true, value: { method, participants, includeSelf } };
}
