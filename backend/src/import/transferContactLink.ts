import { Op } from 'sequelize';
import { Account, Contact, ProviderJobLog, Transaction } from '../models';
import { planTransferLinks, type LinkCandidateRow, type TransferLinkPlan } from './planTransferLinks';
import type { MatchableContact } from '../contacts/contactTermMatch';
import { logger } from '../observability/logger';

export const TRANSFER_LINK_PROVIDER = 'transfer_contact_link' as const;

/** Account types whose lines plausibly carry a person-to-person transfer. */
const IN_SCOPE_ACCOUNT_TYPES = ['checking', 'savings', 'cash'] as const;
/** Merchant substrings (lowercased) that mark a row as a person-to-person flow. */
const TRANSFER_HINTS = ['transfer', 'e-transfer', 'etransfer', 'interac'];

export interface TransferLinkResult {
  processed: number;
  linked: number;
  ambiguous: TransferLinkPlan['ambiguous'];
  dryRun: boolean;
  elapsedMs: number;
}

const inFlight = new Set<number>();
export function isTransferLinkRunning(householdId: number): boolean {
  return inFlight.has(householdId);
}
export function _resetTransferLinkInFlightForTest(): void {
  inFlight.clear();
}

function isTransferLike(txnType: string | null, merchant: string): boolean {
  if (txnType === 'transfer') return true;
  const m = merchant.toLowerCase();
  return TRANSFER_HINTS.some((h) => m.includes(h));
}

export async function runTransferContactLink(
  opts: { householdId: number; dryRun?: boolean },
): Promise<TransferLinkResult> {
  const { householdId, dryRun = false } = opts;
  if (inFlight.has(householdId)) {
    throw new Error(`transfer contact link already running for household ${householdId}`);
  }
  inFlight.add(householdId);
  const startedAt = Date.now();
  let processed = 0;
  let linked = 0;
  let ambiguous: TransferLinkPlan['ambiguous'] = [];
  let status: 'ok' | 'error' = 'ok';

  try {
    const contactRows = await Contact.findAll({ where: { householdId } });
    const contacts: MatchableContact[] = contactRows.map((c) => ({
      id: c.id, name: c.name, normalizedName: c.normalizedName ?? null, aliases: c.aliases ?? null,
    }));
    if (contacts.length === 0) {
      return { processed: 0, linked: 0, ambiguous: [], dryRun, elapsedMs: Date.now() - startedAt };
    }

    const txns = await Transaction.findAll({
      where: { householdId, counterpartyContactId: { [Op.is]: null } },
      include: [{
        model: Account, as: 'account', attributes: ['accountType'], required: true,
        where: { accountType: { [Op.in]: [...IN_SCOPE_ACCOUNT_TYPES] } },
      }],
      order: [['date', 'ASC'], ['id', 'ASC']],
    });

    const candidates: LinkCandidateRow[] = [];
    for (const t of txns) {
      const merchant = `${t.merchantClean ?? ''} ${t.merchantRaw ?? ''} ${t.counterpartyRaw ?? ''}`.trim();
      if (!isTransferLike(t.txnType ?? null, merchant)) continue;
      candidates.push({ id: t.id, merchantText: merchant });
    }
    processed = candidates.length;

    const plan = planTransferLinks(candidates, contacts);
    ambiguous = plan.ambiguous;

    if (!dryRun) {
      for (const { txnId, contactId } of plan.unambiguous) {
        const [count] = await Transaction.update(
          { counterpartyContactId: contactId },
          { where: { id: txnId, householdId, counterpartyContactId: { [Op.is]: null } } },
        );
        if (count > 0) linked++;
      }
    } else {
      linked = plan.unambiguous.length;
    }
  } catch (err) {
    status = 'error';
    logger.error({ err, householdId, module: 'transfer_contact_link' }, 'transfer_contact_link_failed');
    throw err;
  } finally {
    inFlight.delete(householdId);
  }

  const elapsedMs = Date.now() - startedAt;
  if (!dryRun) {
    await ProviderJobLog.create({
      provider: TRANSFER_LINK_PROVIDER, function: 'link', symbol: String(householdId),
      status, httpStatus: null,
      errorMessage: JSON.stringify({ processed, linked, ambiguous: ambiguous.length, elapsedMs }),
      fetchedAt: new Date(),
    });
  }
  return { processed, linked, ambiguous, dryRun, elapsedMs };
}
