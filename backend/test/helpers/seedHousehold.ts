/**
 * Seeds a non-superadmin household for integration tests.
 *
 * Each integration test file bootstraps its own SQLite DB and registers a
 * single superadmin via /api/auth/register. To exercise household-scoped
 * code paths (the common case in production), tests then need to seed
 * additional non-superadmin households via direct model writes — the
 * second registration would itself be promoted to superadmin only when
 * no users exist, but it would require an invite token after that, so
 * direct DB seeding is much simpler.
 *
 * Each seeded household returns a session token; the caller can attach
 * it to a supertest agent via `agent.jar.setCookie('cashflow_session=...')`.
 *
 * Extracted from `backend/test/integration/settlements.test.ts` so the
 * new summary/transactions integration suites can re-use the same code.
 */
import crypto from 'crypto';

export type SeededHousehold = {
  token: string;
  contactId: number;
  householdId: number;
  userId: number;
};

export async function seedHousehold(
  emailPrefix: string,
  contactName: string
): Promise<SeededHousehold> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({
    name: `${emailPrefix} household`,
  });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const contact = await models.Contact.create({
    householdId: household.id,
    name: contactName,
    notes: null,
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, contactId: contact.id, householdId: household.id, userId: user.id };
}
