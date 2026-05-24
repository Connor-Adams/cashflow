export type AccountKind = 'asset' | 'liability';

const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'mortgage']);
const KNOWN_ASSET_TYPES = new Set(['checking', 'savings', 'investment', 'cash']);

export function accountKind(accountType: string): AccountKind {
  if (LIABILITY_TYPES.has(accountType)) return 'liability';
  if (!KNOWN_ASSET_TYPES.has(accountType)) {
    console.warn(`[networth] unknown accountType: ${accountType} — defaulting to asset`);
  }
  return 'asset';
}
