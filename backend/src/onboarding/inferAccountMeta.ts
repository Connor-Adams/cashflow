import path from 'path';
import { parseStatementFilename } from '../import/parseStatementFilename';
import {
  parseWealthsimpleFilename,
  type WsProductHint,
} from '../import/parseWealthsimpleFilename';
import type { OnboardingAccountType } from './accountType';

/**
 * Inferred account metadata for the first-run onboarding import (#259).
 *
 * `name` is always present when inference succeeds. `type` may be undefined
 * when we can guess the name but not the kind (e.g. a `CardName_YYYY_MM.csv`
 * filename tells us the institution but not whether it's chequing vs credit) —
 * the caller defaults an undefined type to `checking`.
 */
export type InferredAccountMeta = {
  name: string;
  type?: OnboardingAccountType;
};

const WS_HINT_TO_META: Record<
  WsProductHint,
  { name: string; type: OnboardingAccountType }
> = {
  chequing: { name: 'Wealthsimple Chequing', type: 'checking' },
  save_for_business: { name: 'Wealthsimple Save for Business', type: 'checking' },
  corporate_chequing: { name: 'Wealthsimple Corporate Chequing', type: 'checking' },
  tfsa: { name: 'Wealthsimple TFSA', type: 'investment' },
  fhsa: { name: 'Wealthsimple FHSA', type: 'investment' },
  margin: { name: 'Wealthsimple Investing', type: 'investment' },
  corporate_investing: { name: 'Wealthsimple Corporate Investing', type: 'investment' },
  crypto: { name: 'Wealthsimple Crypto', type: 'investment' },
  credit_card: { name: 'Wealthsimple Credit Card', type: 'credit' },
};

/** Pull the first `<ACCTID>...` value out of an OFX/QFX document. */
function ofxAcctId(text: string): string | null {
  const m = text.match(/<ACCTID>([^<\r\n]+)/i);
  if (!m) return null;
  const raw = m[1].trim();
  return raw.length > 0 ? raw : null;
}

/** Map an OFX `<ACCTTYPE>` to our onboarding type vocabulary, if present. */
function ofxAcctType(text: string): OnboardingAccountType | undefined {
  const m = text.match(/<ACCTTYPE>([^<\r\n]+)/i);
  if (!m) {
    // Credit-card statements use <CCACCTFROM> instead of <BANKACCTFROM>.
    return /<CCACCTFROM>/i.test(text) ? 'credit' : undefined;
  }
  const t = m[1].trim().toUpperCase();
  if (t === 'SAVINGS') return 'savings';
  if (t === 'CHECKING' || t === 'CHEQUING') return 'checking';
  if (t === 'CREDITLINE' || t === 'CREDITCARD') return 'credit';
  if (t === 'MONEYMRKT') return 'savings';
  return undefined;
}

/** Last-4 mask for an account id, e.g. "1234567" -> "Account ••3567". */
function maskAcctId(acctId: string): string {
  const digits = acctId.replace(/[^0-9A-Za-z]/g, '');
  const last4 = digits.slice(-4);
  return last4 ? `Account ••${last4}` : 'Imported Account';
}

/**
 * Infer an account name (and, when possible, type) for the onboarding
 * import-creates-accounts flow, using filename heuristics and OFX metadata.
 *
 * Order of attempts:
 *   1. Wealthsimple bundle filename -> name + type from the product hint.
 *   2. OFX / QFX `<ACCTID>` -> "Account ••<last4>", type from `<ACCTTYPE>`.
 *   3. `CardName_YYYY_MM.csv` (folder-scan convention) -> name = CardName,
 *      type left undefined (caller defaults to checking).
 *
 * Returns null when none match — the caller then prompts the user for a
 * name + type (AC #5). Deliberately does NOT inspect CSV row content
 * (explicitly out of scope in the issue).
 */
export function inferAccountMeta(opts: {
  fileName: string;
  buffer: Buffer;
}): InferredAccountMeta | null {
  const fileName = path.basename(opts.fileName || '').replace(/[\\/]/g, '');
  const ext = path.extname(fileName).toLowerCase();

  // 1. Wealthsimple bundle filename (CSV).
  const ws = parseWealthsimpleFilename(fileName);
  if (ws) {
    const meta = WS_HINT_TO_META[ws.productHint];
    if (meta) return { name: meta.name, type: meta.type };
  }

  // 2. OFX / QFX account metadata.
  if (ext === '.ofx' || ext === '.qfx') {
    const text = opts.buffer.toString('utf8');
    const acctId = ofxAcctId(text);
    if (acctId) {
      return { name: maskAcctId(acctId), type: ofxAcctType(text) };
    }
  }

  // 3. Generic `CardName_YYYY_MM.csv` filename — name only.
  if (ext === '.csv') {
    const meta = parseStatementFilename(fileName);
    if (meta && meta.cardToken) {
      return { name: meta.cardToken };
    }
  }

  return null;
}
