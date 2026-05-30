export const TRANSACTION_STATUSES = ['pending', 'posted', 'cleared'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export function isTransactionStatus(value: unknown): value is TransactionStatus {
  return (
    typeof value === 'string' &&
    (TRANSACTION_STATUSES as readonly string[]).includes(value)
  );
}

