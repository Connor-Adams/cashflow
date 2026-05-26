import { logger as defaultLogger } from '../observability/logger';
import type { Logger } from 'pino';

export type AccountKind = 'asset' | 'liability';

const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'mortgage']);
const KNOWN_ASSET_TYPES = new Set(['checking', 'savings', 'investment', 'cash']);

export function accountKind(accountType: string, log: Pick<Logger, 'warn'> = defaultLogger): AccountKind {
  if (LIABILITY_TYPES.has(accountType)) return 'liability';
  if (!KNOWN_ASSET_TYPES.has(accountType)) {
    log.warn({ accountType, module: 'networth' }, 'unknown_account_type_default_asset');
  }
  return 'asset';
}
