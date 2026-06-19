import type { Transaction } from 'sequelize';
import { Contact } from '../models';

/**
 * Resolve the Contact that represents a household member for fairness/splits.
 * Adopts the household's single unlinked is_partner Contact when present
 * (so the pre-existing "partner" row gets wired to the new login), otherwise
 * creates a fresh is_partner Contact linked to the user. A contact already
 * linked to a different user is never adopted.
 */
export async function resolveOrCreatePartnerContact(opts: {
  householdId: number;
  userId: number;
  displayName: string;
  transaction: Transaction;
}): Promise<Contact> {
  const { householdId, userId, displayName, transaction } = opts;

  // A household should hold at most one unlinked partner Contact (the invite
  // flow creates exactly one). If multiple ever exist, adopt the oldest
  // deterministically — the partial unique index on (household_id, user_id)
  // still prevents two contacts from linking to the same user.
  const existing = await Contact.findOne({
    where: { householdId, isPartner: true, userId: null },
    order: [['id', 'ASC']],
    transaction,
  });
  if (existing) {
    await existing.update({ userId }, { transaction });
    return existing;
  }
  return Contact.create(
    { householdId, userId, name: displayName, isPartner: true },
    { transaction },
  );
}
