import { Entity } from '../../models';

/**
 * The fields the owner-paid test reads. Structural, so both builders can pass
 * their Transaction rows without a cast.
 */
interface OwnerPaidRow {
  amount: unknown;
  taxTreatmentOverride: string | null;
  finalBusiness: boolean;
  txnType?: string | null;
}

/**
 * A business cost the owner fronted on a personal account, which buildCorpFacts
 * deducts on the corporation's T2 when the household has exactly one corporation.
 *
 * One predicate for both returns. buildPersonalFacts used to route the same rows
 * to self-employment expenses (L13500) as well, so every such dollar was deducted
 * twice — once on each return.
 */
export function isOwnerPaidCorpExpense(t: OwnerPaidRow): boolean {
  if (!t.finalBusiness) return false;
  // Inflows are refunds or the reimbursement itself, not costs.
  if (!(Number(t.amount) < 0)) return false;
  // Moving money is not spending it; buying securities is capital.
  const txnType = t.txnType ?? null;
  if (txnType === 'payment' || txnType === 'transfer' || txnType === 'investment') return false;
  // A row already classified as something else (a donation, an RRSP
  // contribution, a shareholder-loan leg) is not a corporate cost.
  if (t.taxTreatmentOverride != null && t.taxTreatmentOverride !== 'none') return false;
  return true;
}

/**
 * Owner-paid costs are attributed to a corporation only when there is exactly one
 * to attribute them to: nothing in the data says which of several corps incurred
 * a personal-card expense.
 */
export async function hasSingleCorp(householdId: number): Promise<boolean> {
  const corps = await Entity.count({ where: { householdId, kind: 'corp' } });
  return corps === 1;
}
