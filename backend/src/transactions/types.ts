export const TRANSACTION_STATUSES = ['pending', 'posted', 'cleared'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export function isTransactionStatus(value: unknown): value is TransactionStatus {
  return (
    typeof value === 'string' &&
    (TRANSACTION_STATUSES as readonly string[]).includes(value)
  );
}

export const TAX_TREATMENTS = [
  'eligible_dividend',
  'non_eligible_dividend',
  'salary',
  'loan_advance',
  'loan_repayment',
  'employment_income',
  'not_income',
] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export function isTaxTreatment(value: unknown): value is TaxTreatment {
  return (
    typeof value === 'string' &&
    (TAX_TREATMENTS as readonly string[]).includes(value)
  );
}

