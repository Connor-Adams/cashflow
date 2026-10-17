import { Account } from '../models';
import { hashBankAccountNumber } from '../models/Account';

export type BankCode = 'RBC' | 'TD' | 'Scotiabank' | 'BMO' | 'CIBC' | 'Tangerine' | 'EQ Bank' | 'National Bank' | 'Amex' | 'Wealthsimple' | 'Unknown';

export function profileIdToBankCode(profileId: string): BankCode {
  const map: Record<string, BankCode> = {
    rbc: 'RBC',
    td_credit_card: 'TD',
    td_banking: 'TD',
    scotiabank_credit_card: 'Scotiabank',
    scotiabank_banking: 'Scotiabank',
    bmo_credit_card: 'BMO',
    bmo_banking: 'BMO',
    cibc: 'CIBC',
    tangerine: 'Tangerine',
    eq_bank: 'EQ Bank',
    national_bank: 'National Bank',
    generic_amex: 'Amex',
    amex: 'Amex',
    wealthsimple_cash: 'Wealthsimple',
  };
  return map[profileId] || 'Unknown';
}

export async function findOrCreateAccount(
  csvAccountNumber: string | null,
  profileId: string,
  householdId: number | null,
  accountTypeHint: string | null = null
): Promise<{ account: Account; matchedBy: 'bank_number' | 'created' }> {
  const bankCode = profileIdToBankCode(profileId);

  // If no account number, can't match
  if (!csvAccountNumber || csvAccountNumber.trim() === '') {
    throw new Error(
      `Cannot auto-match account: no Account Number found in CSV. Pass accountId explicitly.`
    );
  }

  const trimmedNumber = csvAccountNumber.trim();

  // Try to find existing account with same bank account number in this
  // household. The number is encrypted at rest (#871), so we can't query by the
  // plaintext value — match on the deterministic sha256 hash column instead.
  const existing = await Account.findOne({
    where: {
      bankAccountNumberHash: hashBankAccountNumber(trimmedNumber),
      householdId,
    },
  });

  if (existing) {
    return { account: existing, matchedBy: 'bank_number' };
  }

  // Create new account
  const lastFourDigits = trimmedNumber.slice(-4).padStart(4, '0');
  const newAccount = await Account.create({
    name: `${bankCode} ${lastFourDigits}`,
    owner: 'me',
    householdId,
    visibility: 'private',
    accountType: accountTypeHint || 'checking',
    bankAccountNumber: trimmedNumber,
  });

  return { account: newAccount, matchedBy: 'created' };
}
