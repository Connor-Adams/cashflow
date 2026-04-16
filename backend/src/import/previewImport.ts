import { Account } from '../models';
import * as env from '../config/env';
import { parseCsvRecords } from './csvParse';
import { mapCsvRow } from './mapRow';

export const PREVIEW_MAX_ROWS = 25;

export type PreviewMapped = {
  date: string;
  merchantClean: string;
  amount: number;
  currency: string;
};

export type PreviewRow =
  | { rowIndex: number; ok: true; mapped: PreviewMapped }
  | { rowIndex: number; ok: false; error: string };

export async function previewImportCsv(opts: {
  buffer: Buffer;
  profileId: string;
  accountId: number;
}): Promise<
  | { ok: false; error: string }
  | { ok: true; headers: string[]; rows: PreviewRow[] }
> {
  const account = await Account.findByPk(opts.accountId);
  if (!account) {
    return { ok: false, error: 'No account with that id' };
  }
  const defaultCurrency =
    account.defaultCurrency || env.defaultCurrency || 'CAD';
  const text = opts.buffer.toString('utf8');
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const { records, headers } = parsed;
  const profileId =
    opts.profileId || process.env.CSV_PROFILE_ID || 'generic_simple';
  const rows: PreviewRow[] = [];
  const n = Math.min(records.length, PREVIEW_MAX_ROWS);
  for (let i = 0; i < n; i++) {
    const row = records[i];
    const mapped = mapCsvRow(row, headers, profileId, defaultCurrency);
    if ('error' in mapped) {
      rows.push({ rowIndex: i + 1, ok: false, error: mapped.error });
    } else {
      const v = mapped.value;
      rows.push({
        rowIndex: i + 1,
        ok: true,
        mapped: {
          date: v.date,
          merchantClean: v.merchantClean,
          amount: v.amount,
          currency: v.currency,
        },
      });
    }
  }
  return { ok: true, headers, rows };
}
