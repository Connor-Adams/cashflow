import { logger } from '../observability/logger';

export type AccountKind = 'asset' | 'liability';

const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'mortgage']);
const KNOWN_ASSET_TYPES = new Set(['checking', 'savings', 'investment', 'cash']);

export function accountKind(accountType: string): AccountKind {
  if (LIABILITY_TYPES.has(accountType)) return 'liability';
  if (!KNOWN_ASSET_TYPES.has(accountType)) {
    logger.warn({ accountType, module: 'networth' }, 'unknown_account_type_default_asset');
  }
  return 'asset';
}
