import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Contact } from '../models';
import { resolveSolePartnerId } from '../summary/partnerMath';

/**
 * The household's partner Contact (contacts.is_partner) when it has exactly
 * one; null when it has none, several, or no household. Partner splits are
 * attributed to this contact — see `partnerMath.attributeSplitContact`.
 */
export async function findSolePartnerContactId(
  householdId: number | null,
  options?: { transaction?: SequelizeTransaction },
): Promise<number | null> {
  if (householdId == null) return null;
  const partners = await Contact.findAll({
    where: { householdId, isPartner: true },
    attributes: ['id'],
    // Two rows are enough to tell "exactly one" from "several".
    limit: 2,
    raw: true,
    transaction: options?.transaction,
  });
  return resolveSolePartnerId(partners.map((p) => p.id));
}

/**
 * The ownershipContactId to stamp on a transaction with this ownership type:
 * partner/shared splits carry the sole partner (when unambiguous) so a
 * settlement against that partner nets against them; 'me' rows carry nothing.
 * 'contact' rows are not handled here — the user picks the contact.
 */
export function ownershipContactIdFor(
  ownershipType: 'me' | 'partner' | 'shared',
  solePartnerId: number | null,
): number | null {
  return ownershipType === 'me' ? null : solePartnerId;
}
