/**
 * Audited query executors for natural-language query intents.
 *
 * Every executor here takes a {@link QueryIntent} that has already passed
 * {@link validateIntent}. None of them interpolate raw SQL or accept any
 * field name from the AI as a column reference. The shape of every executor
 * output is fixed so the route response is deterministic.
 *
 * Auth scoping is applied UNCONDITIONALLY here — never trust the AI's idea
 * of "scope". The user's household is the source of truth and comes from the
 * authenticated request via `visibleTransactionWhere` / `householdWhere`.
 */
import type { Request } from 'express';
import { Op } from 'sequelize';
import type { WhereOptions } from 'sequelize';

import {
  Contact,
  PartnerSettlement,
  Transaction,
  sequelize,
} from '../models/index.js';
import { householdWhere, visibleTransactionWhere } from '../auth/scope.js';
import { num } from '../util/numbers.js';
import { caseInsensitiveLikeOp } from './chat/_common.js';
import { resolveDateRange } from './queryDateRanges.js';
import type { QueryIntent } from './queryIntents.js';

const MAX_SOURCE_TRANSACTIONS = 50;
const MAX_GROUP_BUCKETS = 25;

export type SourceTransaction = {
  id: number;
  date: string;
  merchant: string;
  amount: number;
  currency: string;
  category: string | null;
};

export type QueryGroup = {
  key: string;
  count: number;
  total: number;
};

export type QueryAnswer = {
  /** Human-readable headline summarising the answer. */
  headline: string;
  /** Currency totals for the matched transactions. */
  totalsByCurrency: Array<{ currency: string; total: number; count: number }>;
  /** Optional grouping breakdown when the intent requested groupBy. */
  groups?: QueryGroup[];
  /** Optional comparison detail when the intent is `comparison`. */
  comparison?: {
    periodA: { label: string; total: number; count: number };
    periodB: { label: string; total: number; count: number };
    delta: number;
    pctChange: number | null;
  };
  /** Optional subscription rows for `subscription_increase_check`. */
  subscriptionsIncreased?: Array<{
    merchant: string;
    currency: string;
    earlierAvg: number;
    laterAvg: number;
    pctChange: number;
    occurrencesEarlier: number;
    occurrencesLater: number;
  }>;
  /** Optional partner balance detail. */
  partnerBalances?: Array<{
    contactName: string;
    currency: string;
    netBalance: number;
    direction: 'partner_owes_me' | 'i_owe_partner' | 'settled';
  }>;
};

export type ExecuteResult = {
  intent: QueryIntent;
  answer: QueryAnswer;
  sources: SourceTransaction[];
};

type TxnRow = {
  id: number;
  date: string;
  merchantRaw: string | null;
  merchantClean: string | null;
  amount: unknown;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  finalSplitType: string;
};

function txnAttributes(): (keyof TxnRow)[] {
  return [
    'id',
    'date',
    'merchantRaw',
    'merchantClean',
    'amount',
    'currency',
    'finalCategory',
    'finalBusiness',
    'finalSplitType',
  ];
}

function toSourceTransaction(row: TxnRow): SourceTransaction {
  const merchant =
    (row.merchantClean ?? '').trim() ||
    (row.merchantRaw ?? '').trim() ||
    '(unknown)';
  return {
    id: row.id,
    date: row.date,
    merchant,
    amount: num(row.amount) ?? 0,
    currency: row.currency,
    category: row.finalCategory,
  };
}

/**
 * Apply the common transaction filters from the validated intent to a
 * `where` clause. Each branch reads from a FIXED set of source fields — the
 * AI never picks column names.
 */
function applyCommonFilters(
  base: WhereOptions,
  filters:
    | NonNullable<Extract<QueryIntent, { intent: 'transaction_summary' }>['filters']>
    | NonNullable<Extract<QueryIntent, { intent: 'transaction_search' }>['filters']>
    | NonNullable<Extract<QueryIntent, { intent: 'comparison' }>['filters']>,
  today: Date,
  extraDateBounds?: { from?: string; to?: string },
): WhereOptions {
  const where: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (filters.category) {
    where.finalCategory = filters.category;
  }
  if (filters.merchant) {
    where.merchantClean = { [caseInsensitiveLikeOp()]: `%${filters.merchant}%` };
  }
  if (filters.currency) {
    where.currency = filters.currency;
  }
  if (filters.business === true) {
    where.finalBusiness = true;
  } else if (filters.business === false) {
    where.finalBusiness = false;
  }
  if (filters.scope === 'shared') {
    where.finalSplitType = 'shared';
  } else if (filters.scope === 'personal') {
    where.finalSplitType = 'me';
  } else if (filters.scope === 'business') {
    where.finalBusiness = true;
  }
  // Date filters: explicit dateFrom/dateTo win; otherwise dateRange preset.
  const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
  if (filters.dateFrom) dateCond[Op.gte] = filters.dateFrom;
  if (filters.dateTo) dateCond[Op.lte] = filters.dateTo;
  if (
    !filters.dateFrom &&
    !filters.dateTo &&
    filters.dateRange &&
    filters.dateRange !== 'all_time'
  ) {
    const r = resolveDateRange(filters.dateRange, today);
    if (!('all' in r)) {
      dateCond[Op.gte] = r.from;
      dateCond[Op.lte] = r.to;
    }
  }
  if (extraDateBounds?.from) dateCond[Op.gte] = extraDateBounds.from;
  if (extraDateBounds?.to) dateCond[Op.lte] = extraDateBounds.to;
  if (Object.keys(dateCond).length > 0) {
    where.date = dateCond;
  }
  return where as WhereOptions;
}

function groupKeyOf(
  row: TxnRow,
  groupBy: 'category' | 'merchant' | 'currency' | 'month' | 'split',
): string {
  switch (groupBy) {
    case 'category':
      return row.finalCategory ?? 'Uncategorized';
    case 'merchant': {
      const m = (row.merchantClean ?? '').trim() || (row.merchantRaw ?? '').trim();
      return m || '(unknown)';
    }
    case 'currency':
      return row.currency;
    case 'month':
      return (row.date ?? '').slice(0, 7);
    case 'split':
      return row.finalSplitType;
  }
}

function summarizeRows(rows: TxnRow[]): {
  totals: Array<{ currency: string; total: number; count: number }>;
} {
  const byCurrency = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const cur = row.currency || 'UNK';
    const existing = byCurrency.get(cur) ?? { total: 0, count: 0 };
    existing.total += num(row.amount) ?? 0;
    existing.count += 1;
    byCurrency.set(cur, existing);
  }
  return {
    totals: Array.from(byCurrency.entries())
      .map(([currency, v]) => ({ currency, total: round2(v.total), count: v.count }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildGroups(
  rows: TxnRow[],
  groupBy: 'category' | 'merchant' | 'currency' | 'month' | 'split',
): QueryGroup[] {
  const acc = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const k = groupKeyOf(row, groupBy);
    const cur = acc.get(k) ?? { total: 0, count: 0 };
    cur.total += num(row.amount) ?? 0;
    cur.count += 1;
    acc.set(k, cur);
  }
  return Array.from(acc.entries())
    .map(([key, v]) => ({ key, count: v.count, total: round2(v.total) }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    .slice(0, MAX_GROUP_BUCKETS);
}

function headlineForSummary(
  intent: Extract<QueryIntent, { intent: 'transaction_summary' }>,
  totals: Array<{ currency: string; total: number; count: number }>,
  today: Date,
): string {
  const parts: string[] = [];
  if (intent.filters.category) parts.push(`${intent.filters.category}`);
  if (intent.filters.merchant) parts.push(`merchant ~"${intent.filters.merchant}"`);
  if (intent.filters.dateRange) {
    const r = resolveDateRange(intent.filters.dateRange, today);
    parts.push(`for ${r.label}`);
  } else if (intent.filters.dateFrom || intent.filters.dateTo) {
    const from = intent.filters.dateFrom ?? '…';
    const to = intent.filters.dateTo ?? '…';
    parts.push(`from ${from} to ${to}`);
  }
  if (totals.length === 0) return `No matching transactions${parts.length ? ' for ' + parts.join(' ') : ''}.`;
  const totalStr = totals
    .map((t) => `${t.total.toFixed(2)} ${t.currency}`)
    .join(', ');
  const countStr =
    totals.reduce((acc, t) => acc + t.count, 0) === 1 ? '1 transaction' : `${totals.reduce((acc, t) => acc + t.count, 0)} transactions`;
  return `${totalStr} across ${countStr}${parts.length ? ' ' + parts.join(' ') : ''}.`;
}

async function executeTransactionSummary(
  req: Request,
  intent: Extract<QueryIntent, { intent: 'transaction_summary' }>,
  today: Date,
): Promise<ExecuteResult> {
  const where = applyCommonFilters(visibleTransactionWhere(req), intent.filters, today);
  const rows = (await Transaction.findAll({
    where,
    attributes: txnAttributes(),
    order: [
      ['date', 'DESC'],
      ['id', 'DESC'],
    ],
    raw: true,
  })) as unknown as TxnRow[];
  const { totals } = summarizeRows(rows);
  const sources = rows.slice(0, MAX_SOURCE_TRANSACTIONS).map(toSourceTransaction);
  return {
    intent,
    answer: {
      headline: headlineForSummary(intent, totals, today),
      totalsByCurrency: totals,
      ...(intent.groupBy ? { groups: buildGroups(rows, intent.groupBy) } : {}),
    },
    sources,
  };
}

async function executeTransactionSearch(
  req: Request,
  intent: Extract<QueryIntent, { intent: 'transaction_search' }>,
  today: Date,
): Promise<ExecuteResult> {
  const where = applyCommonFilters(visibleTransactionWhere(req), intent.filters, today);
  const rows = (await Transaction.findAll({
    where,
    attributes: txnAttributes(),
    order: [
      ['date', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: MAX_SOURCE_TRANSACTIONS * 4,
    raw: true,
  })) as unknown as TxnRow[];
  // Apply missingReceipt filter in JS: a transaction "has a receipt" when at
  // least one row exists in the receipts table linked to it. Doing this as a
  // post-filter avoids a JOIN on the AI path (the Receipt model exists but
  // joining it requires careful scoping; this is the safe simple path).
  let filtered = rows;
  if (intent.filters.missingReceipt === true) {
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const linked = await listTransactionIdsWithReceipts(req, ids);
      filtered = rows.filter((r) => !linked.has(r.id));
    }
  } else if (intent.filters.missingReceipt === false) {
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const linked = await listTransactionIdsWithReceipts(req, ids);
      filtered = rows.filter((r) => linked.has(r.id));
    }
  }
  const { totals } = summarizeRows(filtered);
  const sources = filtered.slice(0, MAX_SOURCE_TRANSACTIONS).map(toSourceTransaction);
  const totalCount = filtered.length;
  const headline =
    totalCount === 0
      ? 'No transactions matched your filters.'
      : `${totalCount === 1 ? '1 transaction' : `${totalCount} transactions`} matched.`;
  return {
    intent,
    answer: {
      headline,
      totalsByCurrency: totals,
    },
    sources,
  };
}

async function listTransactionIdsWithReceipts(
  req: Request,
  ids: number[],
): Promise<Set<number>> {
  // Scope check: ids come from a query we already scoped to the user's
  // household, but be explicit anyway. The receipt links are scoped to the
  // household via the transactions table; we just enumerate.
  const { Receipt } = await import('../models/index.js');
  const rows = await Receipt.findAll({
    where: { transactionId: { [Op.in]: ids } },
    attributes: ['transactionId'],
    raw: true,
  });
  // Note: visibility check is implicit because the input `ids` came from a
  // visibleTransactionWhere-scoped query; we never expose receipts for txns
  // the user can't see.
  void req;
  return new Set(
    (rows as unknown as Array<{ transactionId: number | null }>)
      .map((r) => r.transactionId)
      .filter((id): id is number => typeof id === 'number'),
  );
}

async function executeComparison(
  req: Request,
  intent: Extract<QueryIntent, { intent: 'comparison' }>,
  today: Date,
): Promise<ExecuteResult> {
  const aRange = resolveDateRange(intent.periodA, today);
  const bRange = resolveDateRange(intent.periodB, today);
  const aBounds = 'all' in aRange ? {} : { from: aRange.from, to: aRange.to };
  const bBounds = 'all' in bRange ? {} : { from: bRange.from, to: bRange.to };

  const baseFilters = intent.filters;
  const aWhere = applyCommonFilters(
    visibleTransactionWhere(req),
    baseFilters,
    today,
    aBounds,
  );
  const bWhere = applyCommonFilters(
    visibleTransactionWhere(req),
    baseFilters,
    today,
    bBounds,
  );
  const [aRows, bRows] = await Promise.all([
    Transaction.findAll({
      where: aWhere,
      attributes: txnAttributes(),
      order: [['date', 'DESC']],
      raw: true,
    }) as unknown as Promise<TxnRow[]>,
    Transaction.findAll({
      where: bWhere,
      attributes: txnAttributes(),
      order: [['date', 'DESC']],
      raw: true,
    }) as unknown as Promise<TxnRow[]>,
  ]);
  const aSum = aRows.reduce((acc, r) => acc + (num(r.amount) ?? 0), 0);
  const bSum = bRows.reduce((acc, r) => acc + (num(r.amount) ?? 0), 0);
  const delta = round2(bSum - aSum);
  const pctChange =
    aSum !== 0 ? round2(((bSum - aSum) / Math.abs(aSum)) * 100) : null;
  const totalsBoth = summarizeRows([...aRows, ...bRows]).totals;
  const sources = [...aRows, ...bRows]
    .sort((x, y) => (x.date < y.date ? 1 : -1))
    .slice(0, MAX_SOURCE_TRANSACTIONS)
    .map(toSourceTransaction);
  const aLabel = 'label' in aRange ? aRange.label : intent.periodA;
  const bLabel = 'label' in bRange ? bRange.label : intent.periodB;
  const headline =
    pctChange == null
      ? `${aLabel}: ${round2(aSum).toFixed(2)}; ${bLabel}: ${round2(bSum).toFixed(2)}.`
      : `${bLabel} vs ${aLabel}: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(1)}%).`;
  return {
    intent,
    answer: {
      headline,
      totalsByCurrency: totalsBoth,
      comparison: {
        periodA: { label: aLabel, total: round2(aSum), count: aRows.length },
        periodB: { label: bLabel, total: round2(bSum), count: bRows.length },
        delta,
        pctChange,
      },
    },
    sources,
  };
}

/**
 * Subscription-increase detection. We treat a "subscription" as a merchant
 * that charges at least 3 times within the window. We split the window into
 * an earlier and a later half; if the average absolute charge in the later
 * half exceeds the earlier half by more than 10%, we flag it.
 *
 * Deliberately implemented in JS, not SQL — the AI never picks fields here.
 */
async function executeSubscriptionIncreaseCheck(
  req: Request,
  intent: Extract<QueryIntent, { intent: 'subscription_increase_check' }>,
  today: Date,
): Promise<ExecuteResult> {
  const months = intent.windowMonths;
  const from = new Date(today);
  from.setMonth(from.getMonth() - months);
  const fromIso = from.toISOString().slice(0, 10);
  const rows = (await Transaction.findAll({
    where: {
      ...visibleTransactionWhere(req),
      date: { [Op.gte]: fromIso },
    },
    attributes: txnAttributes(),
    raw: true,
  })) as unknown as TxnRow[];

  type Group = { merchant: string; currency: string; rows: TxnRow[] };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const amt = num(row.amount) ?? 0;
    if (amt >= 0) continue; // spend only (charges arrive negative)
    const merchant =
      (row.merchantClean ?? '').trim() || (row.merchantRaw ?? '').trim();
    if (!merchant) continue;
    const key = `${merchant.toLowerCase()}\0${row.currency}`;
    const g = groups.get(key) ?? { merchant, currency: row.currency, rows: [] };
    g.rows.push(row);
    groups.set(key, g);
  }

  const increased: NonNullable<QueryAnswer['subscriptionsIncreased']> = [];
  const allSourceRows: TxnRow[] = [];

  for (const g of groups.values()) {
    if (g.rows.length < 3) continue;
    const sorted = [...g.rows].sort((a, b) => a.date.localeCompare(b.date));
    const mid = Math.floor(sorted.length / 2);
    const earlier = sorted.slice(0, mid);
    const later = sorted.slice(mid);
    if (earlier.length === 0 || later.length === 0) continue;
    const earlierAvg =
      earlier.reduce((acc, r) => acc + Math.abs(num(r.amount) ?? 0), 0) /
      earlier.length;
    const laterAvg =
      later.reduce((acc, r) => acc + Math.abs(num(r.amount) ?? 0), 0) / later.length;
    if (earlierAvg <= 0) continue;
    const pctChange = ((laterAvg - earlierAvg) / earlierAvg) * 100;
    if (pctChange <= 10) continue;
    increased.push({
      merchant: g.merchant,
      currency: g.currency,
      earlierAvg: round2(earlierAvg),
      laterAvg: round2(laterAvg),
      pctChange: round2(pctChange),
      occurrencesEarlier: earlier.length,
      occurrencesLater: later.length,
    });
    allSourceRows.push(...sorted);
  }
  increased.sort((a, b) => b.pctChange - a.pctChange);

  const sources = allSourceRows
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, MAX_SOURCE_TRANSACTIONS)
    .map(toSourceTransaction);

  const headline =
    increased.length === 0
      ? `No subscription price increases detected in the last ${months} month${months === 1 ? '' : 's'}.`
      : `${increased.length} subscription${increased.length === 1 ? '' : 's'} increased in the last ${months} month${months === 1 ? '' : 's'}.`;

  return {
    intent,
    answer: {
      headline,
      totalsByCurrency: [],
      subscriptionsIncreased: increased.slice(0, MAX_GROUP_BUCKETS),
    },
    sources,
  };
}

/**
 * Partner-balance executor. Sums the partner share of every shared
 * transaction with an `ownershipContactId`, then nets out PartnerSettlement
 * rows. A positive netBalance means the partner owes the user; a negative
 * means the user owes the partner.
 */
async function executePartnerBalance(
  req: Request,
  intent: Extract<QueryIntent, { intent: 'partner_balance' }>,
): Promise<ExecuteResult> {
  const [txnRows, contacts, settlementRows] = await Promise.all([
    Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        ownershipContactId: { [Op.ne]: null },
      },
      attributes: [
        'id',
        'date',
        'currency',
        'amount',
        'partnerShareAmount',
        'myShareAmount',
        'ownershipContactId',
        'merchantClean',
        'merchantRaw',
        'finalCategory',
        'finalBusiness',
        'finalSplitType',
      ],
      order: [['date', 'DESC']],
      raw: true,
    }),
    Contact.findAll({ where: householdWhere(req), attributes: ['id', 'name'], raw: true }),
    PartnerSettlement.findAll({
      where: householdWhere(req),
      attributes: ['contactId', 'currency', 'direction', 'amount'],
      raw: true,
    }),
  ]);

  type ContactRow = { id: number; name: string };
  type SettlementRow = {
    contactId: number;
    currency: string;
    direction: 'i_paid_partner' | 'partner_paid_me';
    amount: unknown;
  };
  type PartnerTxn = {
    id: number;
    date: string;
    currency: string;
    amount: unknown;
    partnerShareAmount: unknown;
    myShareAmount: unknown;
    ownershipContactId: number | null;
    merchantClean: string | null;
    merchantRaw: string | null;
    finalCategory: string | null;
    finalBusiness: boolean;
    finalSplitType: string;
  };

  const contactsById = new Map(
    (contacts as ContactRow[]).map((c) => [c.id, c.name]),
  );

  type Acc = { net: number; currency: string; contactId: number };
  const balances = new Map<string, Acc>();

  for (const row of txnRows as unknown as PartnerTxn[]) {
    const cid = row.ownershipContactId;
    if (cid == null) continue;
    const cur = row.currency;
    const key = `${cid}\0${cur}`;
    const acc = balances.get(key) ?? { net: 0, currency: cur, contactId: cid };
    // partnerShareAmount is the contact's slice of the spend. A negative
    // number means the user paid for spend belonging to the contact, so the
    // contact owes the user that much.
    acc.net += -(num(row.partnerShareAmount) ?? 0);
    balances.set(key, acc);
  }

  for (const s of settlementRows as unknown as SettlementRow[]) {
    const key = `${s.contactId}\0${s.currency}`;
    const acc = balances.get(key) ?? {
      net: 0,
      currency: s.currency,
      contactId: s.contactId,
    };
    const amount = num(s.amount) ?? 0;
    if (s.direction === 'partner_paid_me') {
      // Partner paid down what they owed, so reduce their balance.
      acc.net -= amount;
    } else {
      // User paid partner — increase what partner owes user (or reverse).
      acc.net += amount;
    }
    balances.set(key, acc);
  }

  const partnerBalances = Array.from(balances.values())
    .map((b) => {
      const net = round2(b.net);
      const direction: 'partner_owes_me' | 'i_owe_partner' | 'settled' =
        net > 0 ? 'partner_owes_me' : net < 0 ? 'i_owe_partner' : 'settled';
      return {
        contactName: contactsById.get(b.contactId) ?? `Contact ${b.contactId}`,
        currency: b.currency,
        netBalance: net,
        direction,
      };
    })
    .sort((a, b) => Math.abs(b.netBalance) - Math.abs(a.netBalance));

  const sources = (txnRows as unknown as PartnerTxn[])
    .slice(0, MAX_SOURCE_TRANSACTIONS)
    .map((r) => ({
      id: r.id,
      date: r.date,
      merchant:
        (r.merchantClean ?? '').trim() || (r.merchantRaw ?? '').trim() || '(unknown)',
      amount: num(r.amount) ?? 0,
      currency: r.currency,
      category: r.finalCategory,
    }));

  const headline =
    partnerBalances.length === 0
      ? 'No partner balances to report.'
      : partnerBalances
          .map((b) => {
            if (b.direction === 'settled') return `${b.contactName}: settled`;
            const amt = Math.abs(b.netBalance).toFixed(2);
            return b.direction === 'partner_owes_me'
              ? `${b.contactName} owes you ${amt} ${b.currency}`
              : `You owe ${b.contactName} ${amt} ${b.currency}`;
          })
          .join('; ');

  return {
    intent,
    answer: { headline, totalsByCurrency: [], partnerBalances },
    sources,
  };
}

/**
 * Dispatch a validated intent to its executor. The executor scope is set by
 * the authenticated request — never by the intent itself.
 */
export async function executeIntent(
  req: Request,
  intent: QueryIntent,
  today: Date = new Date(),
): Promise<ExecuteResult> {
  switch (intent.intent) {
    case 'transaction_summary':
      return executeTransactionSummary(req, intent, today);
    case 'transaction_search':
      return executeTransactionSearch(req, intent, today);
    case 'comparison':
      return executeComparison(req, intent, today);
    case 'subscription_increase_check':
      return executeSubscriptionIncreaseCheck(req, intent, today);
    case 'partner_balance':
      return executePartnerBalance(req, intent);
  }
}

// Re-export for tests/consumers that want a single import.
export { sequelize };
