import type { Signal, TxnType } from './types';

export interface RelationshipCandidate {
  id: number;
  accountId: number;
  amount: number;
  date: string;
  merchantClean: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  /**
   * Bank-supplied transaction identifier (e.g. Wise `BALANCE-5207451832`).
   * When two transactions share the same sourceReference across accounts they
   * are the same logical event under different currencies — the transfer-pair
   * linker uses this to bypass the amount-equality check that would otherwise
   * miss FX conversions.
   */
  sourceReference: string | null;
}

export interface DetectRelationshipsInput {
  txnType: TxnType;
  merchantClean: string;
  amount: number;
  date: string;
  accountId: number;
  householdAccountIds: number[];
  refundWindowDays: number;
  transferWindowDays: number;
  candidates: RelationshipCandidate[];
  /** sourceReference of the txn being enriched (see RelationshipCandidate). */
  sourceReference: string | null;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000,
  ));
}

function findRefundOriginal(input: DetectRelationshipsInput): RelationshipCandidate | null {
  if (input.amount <= 0) return null;
  const targetSign = -1;
  const matches = input.candidates
    .filter((c) => Math.sign(c.amount) === targetSign)
    .filter((c) => c.merchantClean === input.merchantClean)
    .filter((c) => Math.abs(c.amount) >= Math.abs(input.amount))
    .filter((c) => daysBetween(input.date, c.date) <= input.refundWindowDays)
    .sort((a, b) => daysBetween(input.date, a.date) - daysBetween(input.date, b.date));
  return matches[0] ?? null;
}

function findTransferSibling(input: DetectRelationshipsInput): RelationshipCandidate | null {
  // 1) sourceReference match: when both legs of a cross-account transfer carry
  // the same bank-supplied id (e.g. Wise `BALANCE-<id>` on the matching CAD +
  // USD statements), link regardless of amount. FX conversions move different
  // numbers between currencies, so the equal-amount path below would miss it.
  if (input.sourceReference) {
    const byRef = input.candidates
      .filter((c) => c.accountId !== input.accountId)
      .filter((c) => input.householdAccountIds.includes(c.accountId))
      .filter((c) => c.sourceReference != null && c.sourceReference === input.sourceReference)
      .filter((c) => daysBetween(input.date, c.date) <= input.transferWindowDays)
      .sort((a, b) => daysBetween(input.date, a.date) - daysBetween(input.date, b.date));
    if (byRef[0]) return byRef[0];
  }
  // 2) Amount-equality fallback: same-currency transfers (e.g. RBC → WS) that
  // move identical amounts in opposite signs within the transfer window.
  const matches = input.candidates
    .filter((c) => c.accountId !== input.accountId)
    .filter((c) => input.householdAccountIds.includes(c.accountId))
    .filter((c) => Math.sign(c.amount) === -Math.sign(input.amount))
    .filter((c) => Math.abs(Math.abs(c.amount) - Math.abs(input.amount)) <= 0.01)
    .filter((c) => daysBetween(input.date, c.date) <= input.transferWindowDays)
    .sort((a, b) => daysBetween(input.date, a.date) - daysBetween(input.date, b.date));
  return matches[0] ?? null;
}

export function runDetectRelationshipsStage(input: DetectRelationshipsInput): Signal[] {
  const out: Signal[] = [];

  if (input.txnType === 'refund') {
    const original = findRefundOriginal(input);
    if (original) {
      out.push({
        source: 'refund-link',
        confidence: 'high',
        fields: {
          linkedTransactionId: original.id,
          autoCategory: original.finalCategory,
          autoBusiness: original.finalBusiness,
        },
        rationale: `linked to original purchase #${original.id}`,
      });
    }
  }

  if (input.txnType === 'transfer') {
    const sibling = findTransferSibling(input);
    if (sibling) {
      out.push({
        source: 'transfer-link',
        confidence: 'high',
        fields: {
          linkedTransactionId: sibling.id,
          autoCategory: 'Transfer',
        },
        rationale: `linked to sibling transfer #${sibling.id} on account ${sibling.accountId}`,
      });
    }
  }

  return out;
}
