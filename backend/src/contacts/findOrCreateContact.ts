import type { Transaction } from 'sequelize';
import { Contact } from '../models';
import { normalizeContactName } from './normalizeContactName';
import type { ExtractedCounterparty } from '../import/extractCounterparty';

/**
 * Race-safe find-or-create of a Contact by its normalized name within a
 * household. Relies on the unique index (household_id, normalized_name) and
 * the model's beforeValidate hook (which sets normalized_name from name).
 * `rawName` supplies the display casing for a freshly created Contact.
 */
export async function findOrCreateContactByName(
  householdId: number,
  rawName: string,
  options?: { transaction?: Transaction },
): Promise<Contact> {
  const name = rawName.trim();
  const normalized = normalizeContactName(name) ?? name.toLowerCase();
  const [contact] = await Contact.findOrCreate({
    where: { householdId, normalizedName: normalized },
    defaults: { householdId, name, notes: null, normalizedName: normalized } as never,
    transaction: options?.transaction,
  });
  return contact;
}

/**
 * Import-time resolver: only person-kind counterparties get a Contact.
 * Returns the contact id, or null (payroll, no household, or no extraction).
 */
export async function resolveCounterpartyContact(
  householdId: number | null,
  extracted: ExtractedCounterparty | null,
  options?: { transaction?: Transaction },
): Promise<number | null> {
  if (!extracted || extracted.kind !== 'person' || householdId == null) return null;
  const contact = await findOrCreateContactByName(householdId, extracted.name, options);
  return contact.id;
}
