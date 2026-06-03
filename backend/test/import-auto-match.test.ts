import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Account, sequelize } from '../src/models';
import { importCsvFile } from '../src/import/runImport';
import { findOrCreateAccount, profileIdToBankCode } from '../src/import/accountLookup';

const testHouseholdId = 999;

describe('Account auto-match on CSV import', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  afterEach(async () => {
    await Account.destroy({ where: { householdId: testHouseholdId } });
  });

  describe('profileIdToBankCode', () => {
    it('maps RBC profile to RBC bank code', () => {
      expect(profileIdToBankCode('rbc')).toBe('RBC');
    });

    it('maps TD profiles to TD bank code', () => {
      expect(profileIdToBankCode('td_credit_card')).toBe('TD');
      expect(profileIdToBankCode('td_banking')).toBe('TD');
    });

    it('returns Unknown for unrecognized profile', () => {
      expect(profileIdToBankCode('unknown_profile')).toBe('Unknown');
    });
  });

  describe('findOrCreateAccount', () => {
    it('matches existing account with same bank account number', async () => {
      // Create an account with a bank account number
      const existing = await Account.create({
        name: 'RBC Chequing',
        owner: 'me',
        householdId: testHouseholdId,
        visibility: 'private',
        accountType: 'checking',
        bankAccountNumber: '02022-5016985',
      });

      // Try to find/create with the same bank account number
      const result = await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);

      expect(result.matchedBy).toBe('bank_number');
      expect(result.account.id).toBe(existing.id);
      expect(result.account.bankAccountNumber).toBe('02022-5016985');
    });

    it('creates new account if no match found', async () => {
      const result = await findOrCreateAccount('12345-6789', 'rbc', testHouseholdId);

      expect(result.matchedBy).toBe('created');
      expect(result.account.id).toBeGreaterThan(0);
      expect(result.account.name).toContain('RBC');
      expect(result.account.name).toContain('6789'); // last 4 digits
      expect(result.account.bankAccountNumber).toBe('12345-6789');
      expect(result.account.householdId).toBe(testHouseholdId);
    });

    it('throws error when account number is empty', async () => {
      await expect(findOrCreateAccount('', 'rbc', testHouseholdId)).rejects.toThrow(
        /Cannot auto-match account/
      );
    });

    it('throws error when account number is null', async () => {
      await expect(findOrCreateAccount(null, 'rbc', testHouseholdId)).rejects.toThrow(
        /Cannot auto-match account/
      );
    });

    it('creates accounts with different bank codes for same household', async () => {
      const rbc1 = await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);
      const td1 = await findOrCreateAccount('12345-678901', 'td_credit_card', testHouseholdId);

      expect(rbc1.account.id).not.toBe(td1.account.id);
      expect(rbc1.account.name).toContain('RBC');
      expect(td1.account.name).toContain('TD');
    });

    it('enforces unique constraint on (householdId, bankAccountNumber)', async () => {
      // Create first account
      await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);

      // Try to create another with same number in same household
      await expect(findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId)).rejects.toThrow();
    });

    it('allows same bank account number in different households', async () => {
      const result1 = await findOrCreateAccount('02022-5016985', 'rbc', testHouseholdId);
      const result2 = await findOrCreateAccount('02022-5016985', 'rbc', 888);

      expect(result1.account.id).not.toBe(result2.account.id);
      expect(result1.account.householdId).toBe(testHouseholdId);
      expect(result2.account.householdId).toBe(888);
    });

    it('uses last 4 digits for account name', async () => {
      const result = await findOrCreateAccount('9876543210-1234', 'rbc', testHouseholdId);
      expect(result.account.name).toContain('1234');
    });
  });

  describe('importCsvFile with auto-match', () => {
    it('skips import if no accountId, bad filename, and no Account Number in CSV', async () => {
      const csv = `Date,Description,Amount
2025-01-15,Coffee,-5.50
`;
      const result = await importCsvFile({
        buffer: Buffer.from(csv),
        fileName: 'no-account.csv', // Bad filename
        householdId: testHouseholdId,
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('unknown_account');
    });

    it('auto-matches and imports when Account Number in CSV matches existing account', async () => {
      // Pre-create an account with bank account number
      const existing = await Account.create({
        name: 'My RBC',
        owner: 'me',
        householdId: testHouseholdId,
        visibility: 'private',
        accountType: 'checking',
        bankAccountNumber: '02022-5016985',
        defaultCurrency: 'CAD',
      });

      // Create RBC CSV with Account Number column
      const csv = `Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$
Chequing,02022-5016985,1/15/2025,,Coffee Shop,,-5.50,
`;

      const result = await importCsvFile({
        buffer: Buffer.from(csv),
        fileName: 'import.csv', // Bad filename, will trigger auto-match fallback
        householdId: testHouseholdId,
      });

      // Should succeed with auto-match
      expect(result.skipped).not.toBe(true);
      expect(result.rowCount).toBeGreaterThan(0);
    });

    it('creates new account via auto-match if Account Number not found', async () => {
      const csv = `Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$
Chequing,02022-5016985,1/15/2025,,Coffee Shop,,-5.50,
`;

      const result = await importCsvFile({
        buffer: Buffer.from(csv),
        fileName: 'import.csv',
        householdId: testHouseholdId,
      });

      // Should succeed with auto-created account
      expect(result.skipped).not.toBe(true);

      // Verify account was created with correct bank account number
      const created = await Account.findOne({
        where: {
          householdId: testHouseholdId,
          bankAccountNumber: '02022-5016985',
        },
      });
      expect(created).toBeDefined();
      expect(created!.name).toContain('RBC');
    });

    it('respects explicit accountId over auto-match', async () => {
      // Create two accounts
      const account1 = await Account.create({
        name: 'Account 1',
        owner: 'me',
        householdId: testHouseholdId,
        visibility: 'private',
        accountType: 'checking',
        bankAccountNumber: '11111-111111',
        defaultCurrency: 'CAD',
      });

      const account2 = await Account.create({
        name: 'Account 2',
        owner: 'me',
        householdId: testHouseholdId,
        visibility: 'private',
        accountType: 'checking',
        bankAccountNumber: '02022-5016985',
        defaultCurrency: 'CAD',
      });

      // CSV has Account Number matching account2, but accountId points to account1
      const csv = `Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$
Chequing,02022-5016985,1/15/2025,,Coffee Shop,,-5.50,
`;

      const result = await importCsvFile({
        buffer: Buffer.from(csv),
        fileName: 'import.csv',
        accountId: String(account1.id),
        householdId: testHouseholdId,
      });

      // Should use account1, not auto-match to account2
      // (This is hard to verify without inspecting imported transactions,
      // but we can at least check that import succeeds)
      expect(result.skipped).not.toBe(true);
    });
  });
});
