import path from 'path';
import { Op } from 'sequelize';
import { Account, HoldingSnapshot, InvestmentActivity, Transaction } from '../models';
import * as env from '../config/env';
import { parseCsvRecords } from './csvParse';
import { inferCsvDateOrdering, mapCsvRow } from './mapRow';
import { resolveProfileIdForImport } from './inferProfile';
import { normalizeMerchant } from './normalizeMerchant';
import { normalizeSourceRef } from './normalizeSourceRef';
import { parseDateFlexible } from './parseDateFlexible';
import { hashContent, rowFingerprint, stableFingerprint } from './fingerprint';
import { saveStatementPreview } from './statementPreviewStore';
import { extractPdfLines } from './pdf/extractLines';
import { findPdfParser, registerBuiltInPdfParsers } from './pdf/registry';
import type { PdfParseContext } from './pdf/types';
import { parseWsInvestRow, type WsRow } from './wealthsimpleInvestParse';
import {
  parseActivitiesExportRow,
  isActivitiesExportHeaders,
  isAsOfFooterRow,
  type WsActivitiesExportRow,
} from './wealthsimpleActivitiesExportParse';
import { wsTxCodeToTxnType } from './wealthsimpleTxnType';
import type {
  NormalizedCashTransaction,
  NormalizedHoldingSnapshot,
  NormalizedInvestmentActivity,
  NormalizedSecurity,
  StatementPreview,
} from './statementTypes';

function dateOnly(raw: unknown): string | null {
  const parsed = parseDateFlexible(raw);
  if (!parsed) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function num(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  let s = String(raw).replace(/[$,]/g, '').trim();
  if (s.startsWith('(') && s.endsWith(')')) s = `-${s.slice(1, -1)}`;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function currency(raw: unknown, fallback: string): string {
  return String(raw || fallback || 'CAD').trim().toUpperCase().slice(0, 3);
}

function pick(row: Record<string, string>, candidates: string[]): string | undefined {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const found = keys.find((k) => k.trim().toLowerCase() === candidate.toLowerCase());
    if (found && String(row[found] ?? '').trim() !== '') return row[found];
  }
  return undefined;
}

function securityFromRow(
  row: Record<string, string>,
  defaultCurrency: string
): NormalizedSecurity | null {
  const symbol = pick(row, ['Symbol', 'Ticker', 'Security Symbol', 'CUSIP']);
  const name = pick(row, ['Security', 'Security Name', 'Name', 'Description']);
  if (!symbol && !name) return null;
  return {
    symbol: String(symbol || name || 'UNKNOWN').trim().toUpperCase(),
    name: name ? String(name).trim() : null,
    assetType: pick(row, ['Asset Type', 'Security Type', 'Type']) ?? null,
    currency: currency(pick(row, ['Currency', 'Currency Code']), defaultCurrency),
  };
}

function normalizeActivityType(raw: unknown): NormalizedInvestmentActivity['activityType'] {
  const text = String(raw ?? '').toLowerCase();
  if (/\bbuy|bought|purchase/.test(text)) return 'buy';
  if (/\bsell|sold|redemption/.test(text)) return 'sell';
  // ROC must precede generic "distribution" since it commonly appears as
  // "return of capital distribution" or "ROC".
  if (/return.of.capital|roc\b/.test(text)) return 'return_of_capital';
  if (/dividend|distribution/.test(text)) return 'dividend';
  if (/interest/.test(text)) return 'interest';
  if (/fee|commission/.test(text)) return 'fee';
  if (/reinvest/.test(text)) return 'reinvestment';
  if (/split/.test(text)) return 'split';
  // Specific in-kind security transfer flavours must precede the generic
  // 'transfer' branch (which still catches ambiguous cash CONT / withdraw
  // lines and stays a no-op).
  if (/transfer.?in|received.*transfer|deposit.*in.kind/.test(text)) return 'transfer_in';
  if (/transfer.?out|delivered.*transfer|withdraw.*in.kind/.test(text)) return 'transfer_out';
  if (/transfer|deposit|withdraw/.test(text)) return 'transfer';
  return 'other';
}

function parseInvestmentCsv(
  records: Record<string, string>[],
  defaultCurrency: string,
  accountId: number
): {
  investmentActivities: NormalizedInvestmentActivity[];
  holdings: NormalizedHoldingSnapshot[];
  warnings: string[];
  parseErrors: { rowIndex: number; message: string }[];
} {
  const investmentActivities: NormalizedInvestmentActivity[] = [];
  const holdings: NormalizedHoldingSnapshot[] = [];
  const warnings: string[] = [];
  const parseErrors: { rowIndex: number; message: string }[] = [];

  records.forEach((row, index) => {
    const rowIndex = index + 1;
    const activityRaw = pick(row, ['Activity Type', 'Transaction Type', 'Type', 'Action']);
    const symbol = pick(row, ['Symbol', 'Ticker', 'Security Symbol', 'CUSIP']);
    const quantity = num(pick(row, ['Quantity', 'Qty', 'Shares', 'Units']));
    const marketValue = num(pick(row, ['Market Value', 'Current Value', 'Value']));
    const tradeDate = dateOnly(pick(row, ['Trade Date', 'Date', 'Activity Date', 'Transaction Date']));
    const statementDate =
      dateOnly(pick(row, ['Statement Date', 'As Of Date', 'Position Date', 'Date'])) ??
      tradeDate;
    const security = securityFromRow(row, defaultCurrency);
    const rowCurrency = currency(pick(row, ['Currency', 'Currency Code']), defaultCurrency);

    if (security && quantity != null && marketValue != null && !activityRaw) {
      if (!statementDate) {
        parseErrors.push({ rowIndex, message: 'Missing holding statement date' });
        return;
      }
      const price = num(pick(row, ['Price', 'Market Price', 'Unit Price']));
      const fp = stableFingerprint({
        kind: 'holding',
        accountId,
        statementDate,
        symbol: security.symbol,
        quantity,
        marketValue,
      });
      holdings.push({
        statementDate,
        security,
        quantity,
        price,
        marketValue,
        costBasis: num(pick(row, ['Cost Basis', 'Book Cost', 'Book Value', 'Adjusted Cost Base'])),
        unrealizedGainLoss: num(pick(row, ['Unrealized Gain/Loss', 'Unrealized Gain', 'Gain/Loss'])),
        currency: rowCurrency,
        sourceReference: pick(row, ['Reference', 'Id', 'Transaction Id']) ?? null,
        sourceRowFingerprint: fp,
      });
      return;
    }

    if (activityRaw || symbol || quantity != null) {
      if (!tradeDate) {
        parseErrors.push({ rowIndex, message: 'Missing investment activity date' });
        return;
      }
      const description =
        pick(row, ['Description', 'Security', 'Security Name', 'Memo']) ||
        String(activityRaw || 'Investment activity');
      const amount = num(pick(row, ['Amount', 'Net Amount', 'Total', 'Proceeds']));
      const fp = stableFingerprint({
        kind: 'investment_activity',
        accountId,
        tradeDate,
        type: activityRaw,
        symbol: security?.symbol ?? null,
        quantity,
        amount,
      });
      investmentActivities.push({
        activityType: normalizeActivityType(activityRaw),
        tradeDate,
        settlementDate: dateOnly(pick(row, ['Settlement Date', 'Settle Date'])),
        description: String(description),
        security,
        quantity,
        price: num(pick(row, ['Price', 'Unit Price'])),
        amount,
        fees: num(pick(row, ['Fees', 'Commission'])),
        currency: rowCurrency,
        sourceReference: pick(row, ['Reference', 'Id', 'Transaction Id']) ?? null,
        sourceRowFingerprint: fp,
      });
      return;
    }

    warnings.push(`Row ${rowIndex}: not recognized as cash transaction, activity, or holding`);
  });

  return { investmentActivities, holdings, warnings, parseErrors };
}

function tag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i');
  const m = block.match(re);
  return m?.[1]?.trim() ?? null;
}

function blocks(text: string, name: string): string[] {
  const paired = [...text.matchAll(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`, 'gi'))].map(
    (m) => m[0]
  );
  if (paired.length) return paired;
  const starts = [...text.matchAll(new RegExp(`<${name}>`, 'gi'))].map((m) => m.index ?? 0);
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));
}

function ofxDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const basic = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (basic) return `${basic[1]}-${basic[2]}-${basic[3]}`;
  return dateOnly(s);
}

function parseOfx(
  text: string,
  accountId: number,
  defaultCurrency: string
): {
  transactions: NormalizedCashTransaction[];
  investmentActivities: NormalizedInvestmentActivity[];
  holdings: NormalizedHoldingSnapshot[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const transactions: NormalizedCashTransaction[] = [];
  const investmentActivities: NormalizedInvestmentActivity[] = [];
  const holdings: NormalizedHoldingSnapshot[] = [];
  const statementDate =
    ofxDate(tag(text, 'DTASOF')) || ofxDate(tag(text, 'DTEND')) || dateOnly(new Date())!;
  const defaultCurr = currency(tag(text, 'CURDEF'), defaultCurrency);

  for (const block of blocks(text, 'STMTTRN')) {
    const date = ofxDate(tag(block, 'DTPOSTED') || tag(block, 'DTUSER'));
    const amount = num(tag(block, 'TRNAMT'));
    const merchantRaw = tag(block, 'NAME') || tag(block, 'MEMO') || tag(block, 'TRNTYPE');
    if (!date || amount == null || !merchantRaw) {
      warnings.push('Skipped OFX banking transaction with missing date, amount, or description');
      continue;
    }
    const merchantClean = normalizeMerchant(merchantRaw);
    transactions.push({
      date,
      merchantRaw,
      merchantClean,
      amount,
      currency: defaultCurr,
      sourceReference: tag(block, 'FITID'),
      sourceRowFingerprint: rowFingerprint({
        accountId,
        date,
        amount,
        currency: defaultCurr,
        merchantRaw,
        sourceReference: tag(block, 'FITID'),
      }),
    });
  }

  const activityBlockNames = [
    'BUYMF',
    'BUYSTOCK',
    'BUYOTHER',
    'SELLMF',
    'SELLSTOCK',
    'SELLOTHER',
    'INCOME',
    'REINVEST',
    'TRANSFER',
    'INVEXPENSE',
  ];
  for (const blockName of activityBlockNames) {
    for (const block of blocks(text, blockName)) {
      const invTran = tag(block, 'INVTRAN') ? block : block;
      const tradeDate = ofxDate(tag(invTran, 'DTTRADE') || tag(invTran, 'DTPOSTED'));
      if (!tradeDate) {
        warnings.push(`Skipped ${blockName} activity with missing trade date`);
        continue;
      }
      const symbol = tag(block, 'UNIQUEID') || tag(block, 'SECID') || tag(block, 'TICKER');
      const description = tag(invTran, 'MEMO') || tag(block, 'SECNAME') || blockName;
      const rowCurrency = currency(tag(block, 'CURRENCY') || tag(text, 'CURDEF'), defaultCurr);
      const security = symbol
        ? {
            symbol: symbol.toUpperCase(),
            name: tag(block, 'SECNAME'),
            assetType: blockName.includes('MF') ? 'mutual_fund' : 'stock',
            currency: rowCurrency,
          }
        : null;
      const activityType = blockName.startsWith('BUY')
        ? 'buy'
        : blockName.startsWith('SELL')
          ? 'sell'
          : blockName === 'INCOME'
            ? normalizeActivityType(tag(block, 'INCOMETYPE') || 'dividend')
            : blockName === 'REINVEST'
              ? 'reinvestment'
              : blockName === 'INVEXPENSE'
                ? 'fee'
                : 'transfer';
      const quantity = num(tag(block, 'UNITS'));
      const amount = num(tag(block, 'TOTAL'));
      investmentActivities.push({
        activityType,
        tradeDate,
        settlementDate: ofxDate(tag(invTran, 'DTSETTLE')),
        description,
        security,
        quantity,
        price: num(tag(block, 'UNITPRICE')),
        amount,
        fees: num(tag(block, 'FEES') || tag(block, 'COMMISSION')),
        currency: rowCurrency,
        sourceReference: tag(invTran, 'FITID'),
        sourceRowFingerprint: stableFingerprint({
          kind: 'ofx_activity',
          accountId,
          blockName,
          fitid: tag(invTran, 'FITID'),
          tradeDate,
          symbol,
          quantity,
          amount,
        }),
      });
    }
  }

  for (const blockName of ['POSSTOCK', 'POSMF', 'POSOTHER']) {
    for (const block of blocks(text, blockName)) {
      const symbol = tag(block, 'UNIQUEID') || tag(block, 'TICKER');
      const quantity = num(tag(block, 'UNITS'));
      if (!symbol || quantity == null) {
        warnings.push(`Skipped ${blockName} holding with missing symbol or quantity`);
        continue;
      }
      const rowCurrency = currency(tag(block, 'CURRENCY') || tag(text, 'CURDEF'), defaultCurr);
      const price = num(tag(block, 'UNITPRICE'));
      const marketValue = num(tag(block, 'MKTVAL'));
      const security: NormalizedSecurity = {
        symbol: symbol.toUpperCase(),
        name: tag(block, 'SECNAME'),
        assetType: blockName === 'POSMF' ? 'mutual_fund' : 'stock',
        currency: rowCurrency,
      };
      holdings.push({
        statementDate,
        security,
        quantity,
        price,
        marketValue,
        costBasis: num(tag(block, 'DTPRICEASOF')) == null ? null : null,
        unrealizedGainLoss: null,
        currency: rowCurrency,
        sourceReference: tag(block, 'MEMO'),
        sourceRowFingerprint: stableFingerprint({
          kind: 'ofx_holding',
          accountId,
          statementDate,
          symbol,
          quantity,
          marketValue,
        }),
      });
    }
  }

  return { transactions, investmentActivities, holdings, warnings };
}

type TxnDupKeyFields = { date: string; amount: number | string; currency: string; merchantRaw: string };

/**
 * Dup-detection map key. The amount MUST be coerced through Number():
 * incoming preview rows carry a JS number ('-123.45') while existing rows
 * carry the Transaction.amount model attribute, a DECIMAL(14,4) declared as
 * string — Postgres returns it padded to the typmod scale ('-123.4500').
 * Without the coercion the two representations never collide in the Map and
 * every preview row reads as non-duplicate in production (SQLite's numeric
 * affinity returns a plain number, which is why tests passed).
 *
 * Exported for tests.
 */
export function txnDupKey(r: TxnDupKeyFields): string {
  return `${r.date}|${Number(r.amount)}|${r.currency}|${r.merchantRaw}`;
}

function isTxnDuplicate(newRef: string | null, existingRefs: Array<string | null>): boolean {
  if (existingRefs.length === 0) return false;
  if (existingRefs.includes(newRef)) return true;
  if (newRef == null) return existingRefs.some((er) => er != null);
  return existingRefs.some((er) => er == null);
}

async function markDuplicates(preview: Omit<StatementPreview, 'previewToken'>): Promise<void> {
  const txnKeys = preview.transactions.map((r) => ({
    date: r.date,
    amount: String(r.amount),
    currency: r.currency,
    merchantRaw: r.merchantRaw,
  }));
  const existingTxns = txnKeys.length
    ? await Transaction.findAll({
        where: {
          accountId: preview.accountId,
          [Op.or]: txnKeys,
        },
        attributes: ['date', 'amount', 'currency', 'merchantRaw', 'sourceReference'],
      })
    : [];
  const txnIndex = new Map<string, Array<string | null>>();
  for (const e of existingTxns) {
    const k = txnDupKey(e);
    const list = txnIndex.get(k) ?? [];
    list.push(normalizeSourceRef(e.sourceReference));
    txnIndex.set(k, list);
  }
  preview.transactions.forEach((r) => {
    const existingRefs = txnIndex.get(txnDupKey(r)) ?? [];
    r.duplicate = isTxnDuplicate(normalizeSourceRef(r.sourceReference), existingRefs);
  });

  const [acts, holds] = await Promise.all([
    InvestmentActivity.findAll({
      where: {
        accountId: preview.accountId,
        sourceRowFingerprint: preview.investmentActivities.map((r) => r.sourceRowFingerprint),
      },
      attributes: ['sourceRowFingerprint'],
    }),
    HoldingSnapshot.findAll({
      where: {
        accountId: preview.accountId,
        sourceRowFingerprint: preview.holdings.map((r) => r.sourceRowFingerprint),
      },
      attributes: ['sourceRowFingerprint'],
    }),
  ]);
  const actSet = new Set(acts.map((r) => r.sourceRowFingerprint));
  const holdSet = new Set(holds.map((r) => r.sourceRowFingerprint));
  preview.investmentActivities.forEach((r) => {
    r.duplicate = actSet.has(r.sourceRowFingerprint);
  });
  preview.holdings.forEach((r) => {
    r.duplicate = holdSet.has(r.sourceRowFingerprint);
  });
  preview.duplicateCounts.transactions = preview.transactions.filter((r) => r.duplicate).length;
  preview.duplicateCounts.investmentActivities = preview.investmentActivities.filter((r) => r.duplicate).length;
  preview.duplicateCounts.holdings = preview.holdings.filter((r) => r.duplicate).length;
}

/**
 * Returns true when the parsed CSV headers look like a Wealthsimple monthly
 * invest statement: `date,transaction,description,amount,balance,currency`.
 * Used to switch the investment-row parsing path to `parseWsInvestRow` and
 * to enable the zero-value non-CAD crypto-noise filter.
 */
function isWsMonthlyHeaders(headers: string[]): boolean {
  if (!headers || headers.length < 6) return false;
  const wanted = ['date', 'transaction', 'description', 'amount', 'balance', 'currency'];
  const lower = new Set(headers.map((h) => String(h).trim().toLowerCase()));
  return wanted.every((w) => lower.has(w));
}

export async function parseStatementFile(opts: {
  buffer: Buffer;
  fileName: string;
  accountId: number;
  profileId?: string | null;
  batchLabel?: string | null;
  householdId?: number | null;
  /**
   * Force autoBusiness=true on every committed Transaction for this file.
   * Used by the Wealthsimple bundle importer for corporate-tagged accounts
   * (Save for business, Corporate investing).
   */
  overrideBusiness?: boolean;
  /** Pre-extracted pdfjs lines. When set, the .pdf branch skips extractPdfLines
   *  (avoids a second pdfjs pass when the caller already extracted). */
  preExtractedLines?: import('./pdf/types').PdfLine[];
}): Promise<StatementPreview | { ok: false; error: string }> {
  const account = await Account.findOne({
    where: {
      id: opts.accountId,
      ...(opts.householdId != null ? { householdId: opts.householdId } : {}),
    },
  });
  if (!account) return { ok: false, error: 'No account with that id' };

  const fileName = path.basename(opts.fileName || 'statement').replace(/[\\/]/g, '');
  const ext = path.extname(fileName).toLowerCase();
  const defaultCurrency = account.defaultCurrency || env.defaultCurrency || 'CAD';
  const contentHash = hashContent(opts.buffer);
  const now = new Date();
  const importBatch =
    (opts.batchLabel && String(opts.batchLabel).trim()) ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')} ${account.shortCode || account.name}`;
  const base = {
    fileName,
    contentHash,
    accountId: account.id,
    householdId: account.householdId,
    importBatch,
    transactions: [] as NormalizedCashTransaction[],
    investmentActivities: [] as NormalizedInvestmentActivity[],
    holdings: [] as NormalizedHoldingSnapshot[],
    warnings: [] as string[],
    rowErrors: 0,
    parseErrors: [] as { rowIndex: number; message: string }[],
    overrideBusiness: opts.overrideBusiness === true ? true : undefined,
    duplicateCounts: {
      transactions: 0,
      investmentActivities: 0,
      holdings: 0,
    },
  };

  if (ext === '.csv') {
    const parsed = parseCsvRecords(opts.buffer.toString('utf8'));
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { records, headers } = parsed;
    const resolved = resolveProfileIdForImport(
      opts.profileId,
      process.env.CSV_PROFILE_ID,
      headers,
      records,
      defaultCurrency
    );
    const wsActivities = isActivitiesExportHeaders(headers);
    if (wsActivities) {
      // Wealthsimple unified activities-export: one file covers all WS
      // accounts. Filter rows to the upload's target account by matching
      // `account_id` (WS account shortcode) against `account.shortCode`.
      // Emit only InvestmentActivity rows — MoneyMovement and BonusPayment
      // rows belong to the cash-side path (the monthly cash statement
      // parser already covers them with richer merchantRaw text).
      const targetShortCode = (account.shortCode || '').toUpperCase();
      const previewRows: NonNullable<StatementPreview['rows']> = [];
      let nonMatchingAccount = 0;
      let skippedCashSide = 0;
      records.forEach((rec, index) => {
        const row: WsActivitiesExportRow = {
          transaction_date: String(rec['transaction_date'] ?? ''),
          settlement_date: String(rec['settlement_date'] ?? ''),
          account_id: String(rec['account_id'] ?? ''),
          account_type: String(rec['account_type'] ?? ''),
          activity_type: String(rec['activity_type'] ?? ''),
          activity_sub_type: String(rec['activity_sub_type'] ?? ''),
          direction: String(rec['direction'] ?? ''),
          symbol: String(rec['symbol'] ?? ''),
          name: String(rec['name'] ?? ''),
          currency: String(rec['currency'] ?? ''),
          quantity: String(rec['quantity'] ?? ''),
          unit_price: String(rec['unit_price'] ?? ''),
          commission: String(rec['commission'] ?? ''),
          net_cash_amount: String(rec['net_cash_amount'] ?? ''),
        };
        if (isAsOfFooterRow(row)) return;
        if (row.account_id.toUpperCase() !== targetShortCode) {
          nonMatchingAccount += 1;
          return;
        }
        const parsed = parseActivitiesExportRow(row, defaultCurrency);
        if (parsed.kind === 'skip') {
          skippedCashSide += 1;
          return;
        }
        base.investmentActivities.push(parsed.activity);
        previewRows.push({
          rowIndex: index + 1,
          ok: true,
          mapped: {
            date: parsed.activity.tradeDate,
            merchantClean: parsed.activity.description,
            amount: parsed.activity.amount ?? 0,
            currency: parsed.activity.currency,
          },
        });
      });
      if (nonMatchingAccount > 0) {
        base.warnings.push(
          `Filtered ${nonMatchingAccount} row(s) for other accounts (file covers ${
            new Set(records.map((r) => String(r['account_id'] ?? ''))).size
          } accounts; upload one file per account).`,
        );
      }
      if (skippedCashSide > 0) {
        base.warnings.push(
          `Skipped ${skippedCashSide} cash-side row(s) — import these via the monthly cash statement.`,
        );
      }
      const preview = {
        ...base,
        usedParser: 'csv' as const,
        usedProfileId: 'wealthsimple_activities_export',
        profileInferred: true,
        headers,
        rows: previewRows,
        crossSourceDedup: 'fuzzy-window-5d' as const,
      };
      await markDuplicates(preview);
      return saveStatementPreview(preview);
    }

    const wsMonthly = isWsMonthlyHeaders(headers);
    // One day/month ordering for the whole file: unambiguous rows ('15/03')
    // decide how ambiguous ones ('03/04') parse instead of per-row fallback.
    const dateOrdering = inferCsvDateOrdering(records, headers, resolved.profileId);
    const previewRows: NonNullable<StatementPreview['rows']> = [];
    let zeroValueNonCadFiltered = 0;
    records.forEach((row, index) => {
      // Wealthsimple crypto statements emit one zero-value CAD/non-CAD pair per
      // staking reward. The CAD half makes it through (amount=0, currency=CAD)
      // but the non-CAD halves are noise — filter them before mapping.
      // Also: WS invest CSVs end with one blank row that would otherwise hit
      // "Missing required columns" — drop silently.
      if (wsMonthly) {
        const amtStr = String(row['amount'] ?? row['Amount'] ?? '').trim();
        const curStr = String(row['currency'] ?? row['Currency'] ?? '').trim().toUpperCase();
        const dateStr = String(row['date'] ?? row['Date'] ?? '').trim();
        if (amtStr === '' && curStr === '' && dateStr === '') {
          // trailing blank row — silently skip
          return;
        }
        if (amtStr !== '' && parseFloat(amtStr) === 0 && curStr !== 'CAD') {
          zeroValueNonCadFiltered += 1;
          return;
        }
      }
      const mapped = mapCsvRow(row, headers, resolved.profileId, defaultCurrency, dateOrdering);
      if ('error' in mapped) {
        previewRows.push({ rowIndex: index + 1, ok: false, error: mapped.error });
        base.parseErrors.push({ rowIndex: index + 1, message: mapped.error });
        base.rowErrors += 1;
      } else {
        const v = mapped.value;
        const fp = rowFingerprint({
          accountId: account.id,
          date: v.date,
          amount: v.amount,
          currency: v.currency,
          merchantRaw: v.merchantRaw,
          sourceReference: v.sourceReference,
        });
        // Wealthsimple monthly statements carry an authoritative TX code in
        // the `transaction` column (BUY, SELL, DIV, AFT_IN, AFT_OUT, CONT,
        // P2P_SENT, P2P_RECEIVED, FEE, etc). Stamp the override here so the
        // commit pipeline persists the correct txnType instead of letting
        // the narrative regex default to 'purchase' for negative amounts.
        // Codes we don't have a stable opinion on return null — those fall
        // through to enrichment.
        const overrideTxnType = wsMonthly
          ? wsTxCodeToTxnType(String(row['transaction'] ?? row['Transaction'] ?? ''))
          : null;
        const isInvestment = String(account.accountType) === 'investment';
        if (!(isInvestment && v.amount === 0)) {
          base.transactions.push({
            ...v,
            sourceRowFingerprint: fp,
            ...(overrideTxnType ? { overrideTxnType } : {}),
          });
        }
        previewRows.push({
          rowIndex: index + 1,
          ok: true,
          mapped: {
            date: v.date,
            merchantClean: v.merchantClean,
            amount: v.amount,
            currency: v.currency,
          },
        });
      }
    });

    if (zeroValueNonCadFiltered > 0) {
      base.warnings.push(
        `Filtered ${zeroValueNonCadFiltered} zero-value non-CAD row(s) (crypto staking noise)`,
      );
    }

    if (String(account.accountType) === 'investment') {
      if (wsMonthly) {
        // Wealthsimple monthly invest CSV: emit InvestmentActivity rows from
        // the BUY/SELL/DIV/INT/CONT/FEE/FPLINT lines. Other TX codes return
        // null and stay only as Transaction rows.
        //
        // Apply the same zero-value non-CAD filter as the cash loop so we
        // don't emit hundreds of nuisance FEE-only activities for the USD
        // half of Wealthsimple's CAD/USD crypto-staking pairs.
        records.forEach((row) => {
          const amtStr = String(row['amount'] ?? row['Amount'] ?? '').trim();
          const curStr = String(row['currency'] ?? row['Currency'] ?? '').trim().toUpperCase();
          if (amtStr !== '' && parseFloat(amtStr) === 0 && curStr !== 'CAD') {
            return;
          }
          const wsRow: WsRow = {
            date: String(row['date'] ?? row['Date'] ?? ''),
            transaction: String(row['transaction'] ?? row['Transaction'] ?? ''),
            description: String(row['description'] ?? row['Description'] ?? ''),
            amount: amtStr || '0',
            balance: String(row['balance'] ?? row['Balance'] ?? ''),
            currency: String(row['currency'] ?? row['Currency'] ?? ''),
          };
          const activity = parseWsInvestRow(wsRow, account.id, defaultCurrency);
          if (activity) base.investmentActivities.push(activity);
        });
      } else {
        const inv = parseInvestmentCsv(records, defaultCurrency, account.id);
        base.investmentActivities.push(...inv.investmentActivities);
        base.holdings.push(...inv.holdings);
        base.warnings.push(...inv.warnings);
        base.parseErrors.push(...inv.parseErrors);
        base.rowErrors += inv.parseErrors.length;
      }
    }

    const preview = {
      ...base,
      usedParser: 'csv' as const,
      usedProfileId: resolved.profileId,
      profileInferred: resolved.inferred,
      headers,
      rows: previewRows,
    };
    await markDuplicates(preview);
    return saveStatementPreview(preview);
  }

  if (ext === '.ofx' || ext === '.qfx') {
    const out = parseOfx(opts.buffer.toString('utf8'), account.id, defaultCurrency);
    const preview = {
      ...base,
      usedParser: 'ofx' as const,
      transactions: out.transactions,
      investmentActivities: out.investmentActivities,
      holdings: out.holdings,
      warnings: out.warnings,
      rows: out.transactions.slice(0, 25).map((row, index) => ({
        rowIndex: index + 1,
        ok: true as const,
        mapped: {
          date: row.date,
          merchantClean: row.merchantClean,
          amount: row.amount,
          currency: row.currency,
        },
      })),
    };
    await markDuplicates(preview);
    return saveStatementPreview(preview);
  }

  if (ext === '.pdf') {
    // Guard is idempotent — safe to call here so registration only runs for PDF uploads.
    registerBuiltInPdfParsers();
    let lines;
    if (opts.preExtractedLines) {
      lines = opts.preExtractedLines;
    } else {
      try {
        lines = await extractPdfLines(opts.buffer);
      } catch (err) {
        return { ok: false, error: `Could not read PDF: ${(err as Error).message}` };
      }
    }
    const parser = findPdfParser(lines);
    if (!parser) {
      return {
        ok: false,
        error: 'No PDF parser registered for this statement layout',
      };
    }
    const out = parser.parse(lines, {
      defaultCurrency,
      // Lets a parser that serves several account shapes under one layout
      // (Wealthsimple: brokerage + Cash/Chequing/Save) route rows to the cash
      // ledger vs investment activity by account rather than by row code.
      accountType: account.accountType as PdfParseContext['accountType'],
    });
    const transactions = out.transactions.map((v) => ({
      date: v.date,
      merchantRaw: v.merchantRaw,
      merchantClean: v.merchantClean,
      amount: v.amount,
      currency: v.currency,
      sourceReference: v.sourceReference,
      // Authoritative txnType from the parser (WS code / CC TYPE column) — wins
      // over enrichment's narrative guess in the commit pipeline. undefined for
      // parsers/rows that carry no such signal.
      overrideTxnType: v.overrideTxnType,
      sourceRowFingerprint: rowFingerprint({
        accountId: account.id,
        date: v.date,
        amount: v.amount,
        currency: v.currency,
        merchantRaw: v.merchantRaw,
        sourceReference: v.sourceReference,
      }),
    }));
    // Investment-statement parsers (RBC RDSP, etc) emit activities + holdings
    // alongside cash transactions. Apply the same fingerprinting that the CSV
    // path uses so dedup is consistent across import sources.
    const investmentActivities: NormalizedInvestmentActivity[] = (out.investmentActivities ?? []).map((a) => ({
      ...a,
      sourceRowFingerprint: stableFingerprint({
        kind: 'investment_activity',
        accountId: account.id,
        tradeDate: a.tradeDate,
        type: a.activityType,
        symbol: a.security?.symbol ?? null,
        quantity: a.quantity,
        amount: a.amount,
      }),
    }));
    const holdings: NormalizedHoldingSnapshot[] = (out.holdings ?? []).map((h) => ({
      ...h,
      sourceRowFingerprint:
        parser.holdingFingerprint === 'ws_holding'
          ? stableFingerprint({
              kind: 'ws_holding',
              accountId: account.id,
              statementDate: h.statementDate,
              symbol: h.security.symbol.toUpperCase(),
              currency: h.currency,
            })
          : stableFingerprint({
              kind: 'holding',
              accountId: account.id,
              statementDate: h.statementDate,
              symbol: h.security.symbol,
              quantity: h.quantity,
              marketValue: h.marketValue,
            }),
    }));
    const preview = {
      ...base,
      usedParser: 'pdf' as const,
      usedProfileId: parser.id,
      ...(parser.crossSourceDedup ? { crossSourceDedup: parser.crossSourceDedup } : {}),
      transactions,
      investmentActivities,
      holdings,
      warnings: out.warnings,
      parseErrors: out.parseErrors,
      rowErrors: out.parseErrors.length,
      rows: transactions.slice(0, 25).map((row, index) => ({
        rowIndex: index + 1,
        ok: true as const,
        mapped: {
          date: row.date,
          merchantClean: row.merchantClean,
          amount: row.amount,
          currency: row.currency,
        },
      })),
    };
    await markDuplicates(preview);
    return saveStatementPreview(preview);
  }

  return { ok: false, error: 'Only .csv, .ofx, .qfx, and .pdf files are supported' };
}
