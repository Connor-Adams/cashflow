import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Account: typeof import('../models/Account').Account;
let AccountCardIdentifier: typeof import('../models/AccountCardIdentifier').AccountCardIdentifier;
let Entity: typeof import('../models/Entity').Entity;
let Household: typeof import('../models/Household').Household;
let resolvePdfAccountFromHeader: typeof import('./runImport').resolvePdfAccountFromHeader;

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  Account = models.Account;
  AccountCardIdentifier = models.AccountCardIdentifier;
  Entity = models.Entity;
  Household = models.Household;
  ({ resolvePdfAccountFromHeader } = await import('./runImport'));
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

let householdId: number;
const userId = 1;
beforeEach(async () => {
  await AccountCardIdentifier.destroy({ where: {}, truncate: true, force: true });
  await Account.destroy({ where: {}, truncate: true });
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

/** A Wise PDF header for one currency. accountSuffix = last-4 of the Wise account number. */
function wiseHeader(
  currency: string,
  accountSuffix: string,
  accountHolder: string,
): import('./pdf/types').PdfStatementHeader {
  return {
    accountSuffix,
    productLabel: `Wise ${currency}`,
    accountType: 'checking',
    periodStart: '2025-06-01',
    periodEnd: '2025-06-30',
    currency,
    accountHolder,
  };
}

/** A WS credit-card PDF header. accountSuffix = card last-4 from the statement body. */
function wsCreditCardHeader(last4: string): import('./pdf/types').PdfStatementHeader {
  return {
    accountSuffix: last4,
    productLabel: 'Wealthsimple Credit Card',
    accountType: 'credit_card',
    periodStart: '2026-05-15',
    periodEnd: '2026-06-14',
    currency: 'CAD',
    accountHolder: 'Connor Adams',
  };
}

test('WS credit-card PDF resolves by filename WSID, not body last-4 (no account fork)', async () => {
  // Canonical card account already exists, keyed on the stable WSID and given a
  // user-edited display name (so the name-fallback also misses) — exactly the
  // prod state after the account was renamed. A new month's statement carries
  // the same WSID in its filename but only the last-4 in its body.
  const existing = await Account.create({
    householdId, name: 'Wealthsimple Visa Infinite Priviledge', accountType: 'credit_card',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD', shortCode: 'C13BRX957CAD',
    ownerUserId: userId, entityId: null,
  });

  const r = await resolvePdfAccountFromHeader(
    wsCreditCardHeader('3338'),
    householdId,
    userId,
    'C13BRX957CAD_2026-06_CREDIT_CARD.pdf',
  );

  assert.equal(r.accountCreated, false, 'must reuse the existing card account, not fork a new one');
  assert.equal(r.account.id, existing.id);
  assert.equal(
    (await Account.findAll({ where: { householdId, accountType: 'credit_card' } })).length,
    1,
    'no duplicate credit-card account created',
  );
});

test('first WS credit-card PDF import keys the new account on the filename WSID', async () => {
  const r = await resolvePdfAccountFromHeader(
    wsCreditCardHeader('3338'),
    householdId,
    userId,
    'C13BRX957CAD_2026-06_CREDIT_CARD.pdf',
  );
  assert.equal(r.accountCreated, true);
  assert.equal(r.account.shortCode, 'C13BRX957CAD', 'short_code must be the stable WSID, not the last-4');

  // Next month, same card: must reuse, not fork.
  const again = await resolvePdfAccountFromHeader(
    wsCreditCardHeader('3338'),
    householdId,
    userId,
    'C13BRX957CAD_2026-07_CREDIT_CARD.pdf',
  );
  assert.equal(again.accountCreated, false);
  assert.equal(again.account.id, r.account.id);
});

test('corp Wise statement does NOT merge into the same-named personal Wise account', async () => {
  // Personal Wise USD imported first (different account number → suffix 1111).
  const personal = await resolvePdfAccountFromHeader(
    wiseHeader('USD', '1111', 'Connor Adams'),
    householdId,
    userId,
  );
  assert.equal(personal.accountCreated, true);
  assert.equal(personal.overrideBusiness, false);

  // Corp Wise USD imported next: same product/name, different account number
  // (suffix 2222), corp holder. It MUST create a distinct corp account, not
  // collapse into the personal one — keying on name alone merged it before.
  const corp = await resolvePdfAccountFromHeader(
    wiseHeader('USD', '2222', 'CDG Labs Inc.'),
    householdId,
    userId,
  );
  assert.equal(corp.accountCreated, true, 'corp Wise account must be created, not merged');
  assert.notEqual(corp.account.id, personal.account.id, 'corp and personal Wise must be distinct accounts');
  assert.equal(corp.overrideBusiness, true);

  const corpEntity = await Entity.findByPk(corp.account.entityId);
  assert.equal(corpEntity?.kind, 'corp', 'corp account points at the corp entity');

  const wiseUsd = await Account.findAll({ where: { householdId, name: 'Wise USD' } });
  assert.equal(wiseUsd.length, 2, 'two distinct Wise USD accounts: personal + corp');
});

test('personal Wise statement does NOT merge into a pre-existing corp Wise account', async () => {
  // Reverse direction: corp account exists first.
  const corp = await resolvePdfAccountFromHeader(
    wiseHeader('CAD', '2222', 'CDG Labs Inc.'),
    householdId,
    userId,
  );
  assert.equal(corp.overrideBusiness, true);

  const personal = await resolvePdfAccountFromHeader(
    wiseHeader('CAD', '1111', 'Connor Adams'),
    householdId,
    userId,
  );
  assert.equal(personal.accountCreated, true, 'personal Wise account must be created, not merged into corp');
  assert.notEqual(personal.account.id, corp.account.id);
  assert.equal(personal.overrideBusiness, false);

  const personalEntity = await Entity.findByPk(personal.account.entityId);
  assert.equal(personalEntity?.kind, 'personal', 'personal account points at the personal entity');
});

test('re-importing the same personal Wise statement reuses the account (no duplicate)', async () => {
  const first = await resolvePdfAccountFromHeader(
    wiseHeader('EUR', '3333', 'Connor Adams'),
    householdId,
    userId,
  );
  assert.equal(first.accountCreated, true);

  // Same statement again — must find the existing account by shortCode, not fork.
  const again = await resolvePdfAccountFromHeader(
    wiseHeader('EUR', '3333', 'Connor Adams'),
    householdId,
    userId,
  );
  assert.equal(again.accountCreated, false, 're-import must reuse the existing account');
  assert.equal(again.account.id, first.account.id);
  assert.equal((await Account.findAll({ where: { householdId, name: 'Wise EUR' } })).length, 1);
});

// docs/superpowers/specs/2026-09-11-account-card-identifiers-design.md, Part 2:
// resolvePdfAccountFromHeader harvests header.accountSuffix into
// account_card_identifiers whenever it's a clean 4-digit card last-4,
// regardless of how the account was resolved.
test('harvests a 4-digit accountSuffix as an identifier when the account is resolved by short_code', async () => {
  const r = await resolvePdfAccountFromHeader(wiseHeader('EUR', '4444', 'Connor Adams'), householdId, userId);

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: r.account.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last4, '4444');
  assert.equal(rows[0].source, 'pdf_statement_header');
  assert.equal(rows[0].householdId, householdId);
});

test('harvests the body last-4 even when the account was resolved via the Wealthsimple WSID path (opaque short_code)', async () => {
  // WS credit-card statements key the account on the filename WSID
  // (opaque, e.g. 'C13BRX957CAD') rather than the numeric body last-4 -- the
  // account's short_code therefore stays opaque and resolveAccountLast4
  // derives nothing from it. The harvest must still fire off
  // header.accountSuffix (the body-parsed last-4), which is exactly the
  // "matched by a filename token, not short_code" shape the design calls out
  // for Costco.
  const r = await resolvePdfAccountFromHeader(
    wsCreditCardHeader('3338'),
    householdId,
    userId,
    'C13BRX957CAD_2026-06_CREDIT_CARD.pdf',
  );
  assert.equal(r.account.shortCode, 'C13BRX957CAD', 'short_code stays the opaque WSID');

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: r.account.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last4, '3338');
  assert.equal(rows[0].source, 'pdf_statement_header');
});

test('harvests on the name-fallback resolution path too', async () => {
  // Pre-existing account with a short_code that will NOT match this
  // statement's key, forcing the name+accountType fallback branch.
  const existing = await Account.create({
    householdId, name: 'Wise GBP', accountType: 'checking',
    owner: 'me', visibility: 'private', defaultCurrency: 'GBP', shortCode: 'stale-token',
    ownerUserId: userId, entityId: null,
  });

  const r = await resolvePdfAccountFromHeader(wiseHeader('GBP', '5555', 'Connor Adams'), householdId, userId);
  assert.equal(r.account.id, existing.id, 'must reuse the account found via the name fallback');

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: r.account.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last4, '5555');
  assert.equal(rows[0].source, 'pdf_statement_header');
});

test('does not harvest when accountSuffix is not exactly 4 digits', async () => {
  const opaqueHeader = wsCreditCardHeader('3338');
  const r = await resolvePdfAccountFromHeader(
    { ...opaqueHeader, accountSuffix: 'HQ6LMLTK8CAD' },
    householdId,
    userId,
  );
  const rows = await AccountCardIdentifier.findAll({ where: { accountId: r.account.id } });
  assert.equal(rows.length, 0);
});

test('re-importing the same statement does not duplicate the identifier row', async () => {
  const first = await resolvePdfAccountFromHeader(wiseHeader('USD', '6666', 'Connor Adams'), householdId, userId);
  await resolvePdfAccountFromHeader(wiseHeader('USD', '6666', 'Connor Adams'), householdId, userId);

  const rows = await AccountCardIdentifier.findAll({ where: { accountId: first.account.id } });
  assert.equal(rows.length, 1, 'upsert must not duplicate on repeat import');
});
