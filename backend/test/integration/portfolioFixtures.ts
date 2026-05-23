/**
 * Shared seed helpers for the portfolio v2 integration tests
 * (allocation, income, by-security, realized, security drill). Each
 * test file imports this module AFTER setting process.env.DATABASE_PATH
 * — every helper accepts the live Sequelize models passed in by the
 * caller to avoid module-load order surprises.
 */
import crypto from 'crypto';

type Models = typeof import('../../src/models');
export type SeedAccount = { id: number; name: string; shortCode: string };
export type SeedSecurity = { id: number; symbol: string };

export async function seedHousehold(
  models: Models,
  email: string,
): Promise<{ user: { id: number }; household: { id: number }; token: string }> {
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email,
    displayName: 'Portfolio Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Portfolio Test HH' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { user: { id: user.id }, household: { id: household.id }, token };
}

export async function seedAccount(
  models: Models,
  householdId: number,
  ownerUserId: number,
  name: string,
  shortCode: string,
): Promise<SeedAccount> {
  const account = await models.Account.create({
    householdId,
    ownerUserId,
    owner: 'me',
    visibility: 'shared',
    name,
    accountType: 'investment',
    defaultCurrency: 'CAD',
    shortCode,
  });
  return { id: account.id, name, shortCode };
}

export async function seedSecurity(
  models: Models,
  householdId: number,
  symbol: string,
  name: string,
  assetType: string,
  currency = 'CAD',
): Promise<SeedSecurity> {
  const security = await models.Security.create({
    householdId,
    symbol,
    name,
    assetType,
    currency,
  });
  return { id: security.id, symbol };
}

export async function seedHolding(
  models: Models,
  opts: {
    accountId: number;
    householdId: number;
    securityId: number;
    statementDate: string;
    quantity: number;
    price?: number | null;
    marketValue?: number | null;
    costBasis?: number | null;
    currency?: string;
  },
): Promise<void> {
  await models.HoldingSnapshot.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    securityId: opts.securityId,
    statementDate: opts.statementDate,
    quantity: opts.quantity.toFixed(8),
    price: opts.price != null ? opts.price.toFixed(8) : null,
    marketValue: opts.marketValue != null ? opts.marketValue.toFixed(4) : null,
    costBasis: opts.costBasis != null ? opts.costBasis.toFixed(4) : null,
    unrealizedGainLoss: null,
    currency: opts.currency ?? 'CAD',
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    importBatch: 'portfolio-test',
  });
}

export async function seedActivity(
  models: Models,
  opts: {
    accountId: number;
    householdId: number;
    securityId: number | null;
    activityType: string;
    tradeDate: string;
    description?: string;
    quantity?: number | null;
    price?: number | null;
    amount?: number | null;
    currency?: string;
  },
): Promise<void> {
  await models.InvestmentActivity.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    securityId: opts.securityId,
    activityType: opts.activityType,
    tradeDate: opts.tradeDate,
    settlementDate: null,
    description: opts.description ?? `${opts.activityType} test`,
    quantity: opts.quantity != null ? opts.quantity.toFixed(8) : null,
    price: opts.price != null ? opts.price.toFixed(8) : null,
    amount: opts.amount != null ? opts.amount.toFixed(4) : null,
    fees: null,
    currency: opts.currency ?? 'CAD',
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    importBatch: 'portfolio-test',
  });
}
