import { matchContactsByTerms, type MatchableContact } from '../contacts/contactTermMatch';

export interface LinkCandidateRow {
  id: number;
  merchantText: string;
}

export interface TransferLinkPlan {
  unambiguous: Array<{ txnId: number; contactId: number }>;
  ambiguous: Array<{ txnId: number; merchantText: string; contactIds: number[] }>;
}

/** Partition candidate transfer rows by how many contacts their merchant text
 *  matches: exactly one → auto-linkable; more than one → manual-pick queue;
 *  zero → dropped (not in either bucket). */
export function planTransferLinks(
  rows: LinkCandidateRow[],
  contacts: MatchableContact[],
): TransferLinkPlan {
  const plan: TransferLinkPlan = { unambiguous: [], ambiguous: [] };
  for (const r of rows) {
    const ids = matchContactsByTerms(r.merchantText, contacts);
    if (ids.length === 1) plan.unambiguous.push({ txnId: r.id, contactId: ids[0] });
    else if (ids.length > 1) plan.ambiguous.push({ txnId: r.id, merchantText: r.merchantText, contactIds: ids });
  }
  return plan;
}
