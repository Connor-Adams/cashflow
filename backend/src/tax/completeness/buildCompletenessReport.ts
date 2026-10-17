import { Op } from 'sequelize';
import {
  Account, Carryforward, Category, Entity, InvestmentActivity, Security, TaxSlip, Transaction,
} from '../../models';
import { D, type Decimal } from '../util/decimal';
import { resolveTaxTreatment, type TaxTreatmentMaps } from '../builders/resolveTaxTreatment';
import { activityIdsWithTransaction } from '../../import/wsDepositActivityMigration';
import { detectDuplicateTransactions } from '../../import/detectDuplicateTransactions';
import { createCadConverter } from './cadConverter';
import { DETECTORS } from './detectors';
import { worstStatus } from './status';
import type { RateTable, TaxYearFacts } from '../engine/types';
import type {
  AccountRow, ActivityRow, CadConverter, CompletenessContext, CompletenessReport,
  CompletenessTxn,
} from './types';
import { loadUnimportedOutboundTransfers } from './loadUnimportedOutboundTransfers';

export interface BuildCompletenessReportArgs {
  entityId: number;
  year: number;
  /**
   * The SELECTED SCENARIO's resolved facts, not a fresh build. The gate and the total
   * must share a basis: estimating against actuals while the user is looking at a fork
   * carrying overrides would compute the two numbers on different data.
   */
  facts: TaxYearFacts;
  rates: RateTable;
  /** Injected for testability. */
  now?: Date;
}

/**
 * Slip types something in the tax path actually reads. Anything else is entered and
 * ignored, which is what "reconciles against nothing" means.
 *
 * T4A belongs here: `buildPersonalFacts` reads its boxes 016 and 024 into pension
 * income. Omitting it reported entered pension income as money whose transactions were
 * never imported — with a dollar figure attached — when a different code path had
 * already put it on the return.
 *
 * T5008 is deliberately absent: nothing reads it, so a T5008 genuinely does reconcile
 * against nothing.
 */
const SLIP_TYPES_THE_ENGINE_READS = new Set(['T4', 'T5', 'T3', 'T4A']);

/**
 * Asset types whose distributions the single `dividendEligibility` flag cannot
 * express: a fund distribution is a mix of eligible dividends, foreign income, other
 * income, return of capital and capital gains. `null` is included — an unknown-type
 * security paying distributions is exactly as unverified.
 *
 * In prod every one of the 41 securities carries the default `eligible` and none has
 * ever been set otherwise, which is what makes this worth surfacing.
 */
const FUND_LIKE_ASSET_TYPES: ReadonlySet<string | null> = new Set([
  'etf', 'exchange_traded_fund', 'mutual_fund', 'trust', null,
]);

/**
 * What the return does not know, for a period.
 *
 * Derived on read and never persisted, per the primitives rule — completeness is an
 * observation over Transaction, Document, Period and Account, and asserts no state of
 * its own.
 *
 * **Must not be folded into `factsHash`.** Import coverage changes without any fact
 * changing, so a report keyed on facts would go stale exactly when it matters, which
 * is worse than having no gate at all.
 */
export async function buildCompletenessReport(
  { entityId, year, facts, rates, now = new Date() }: BuildCompletenessReportArgs,
): Promise<CompletenessReport> {
  const entity = await Entity.findByPk(entityId);
  if (!entity) throw new Error(`buildCompletenessReport: entity ${entityId} not found`);
  const householdId = entity.householdId;
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const [accounts, txns, categories, carryforwards, slips] = await Promise.all([
    Account.findAll({ where: { entityId } }),
    Transaction.findAll({ where: { entityId, date: { [Op.between]: [startDate, endDate] } } }),
    Category.findAll({ where: { householdId } }),
    Carryforward.findAll({ where: { entityId }, attributes: ['asOfYear'] }),
    TaxSlip.findAll({ where: { entityId, year } }),
  ]);

  const maps: TaxTreatmentMaps = {
    catById: new Map(
      categories.map((c) => [c.id, { id: c.id, parentId: c.parentId, taxTreatment: c.taxTreatment }]),
    ),
    catTreatment: new Map(categories.map((c) => [c.name, c.taxTreatment])),
  };

  // One converter for the whole report: memoised per currency/date pair, and it
  // degrades to the raw amount rather than throwing a 500 over an advisory overlay.
  const toCadMemo = createCadConverter();
  const personalTxns = await toCompletenessTxns(txns, householdId, maps, toCadMemo);
  const accountIds = accounts.map((a) => a.id);
  const activities = await loadActivities(accounts, startDate, endDate, toCadMemo);

  const ctx: CompletenessContext = {
    entityId,
    year,
    facts,
    rates,
    personalTxns,
    unimportedOutboundTransfers: await loadUnimportedOutboundTransfers(
      householdId, year, toCadMemo,
    ),
    accounts: accounts.map((a): AccountRow => ({
      id: a.id,
      name: a.name,
      accountType: a.accountType ?? '',
      closedAt: a.closedAt === null || a.closedAt === undefined ? null : String(a.closedAt),
      mergedIntoId: a.mergedIntoId ?? null,
    })),
    activities,
    // Scoped to this entity: a corp duplicate is not a personal T1 gap, and bounded
    // to the period because this runs on every request.
    duplicates: await detectDuplicateTransactions({ householdId, entityId, startDate, endDate }),
    carryforwardYears: [...new Set(carryforwards.map((c) => c.asOfYear))],
    slipTypes: [...new Set(slips.map((s) => s.slipType as string))],
    unreconciledSlips: slips
      .filter((s) => !SLIP_TYPES_THE_ENGINE_READS.has(s.slipType as string))
      .map((s) => ({
        slipId: s.id,
        slipType: s.slipType as string,
        amount: largestBox(s.boxValues as Record<string, unknown>),
      })),
    unverifiedEligibility: await loadUnverifiedEligibility(
      accountIds, startDate, endDate, toCadMemo,
    ),
    now,
  };

  const items = DETECTORS.flatMap((detect) => detect(ctx));
  const dates = personalTxns.map((t) => t.date).sort();

  return {
    status: worstStatus(items),
    checkedAt: now.toISOString(),
    coverageThrough: dates.length > 0 ? dates[dates.length - 1] : null,
    blockers: items.filter((i) => i.severity === 'blocker'),
    gaps: items.filter((i) => i.severity === 'gap'),
  };
}

/**
 * Resolve the two things a raw row cannot answer about itself: whether anything points
 * at it (the link pointer is one-directional, so a row can be half of a pair without
 * knowing it) and whether its counterpart belongs to a corp entity.
 */
async function toCompletenessTxns(
  txns: Transaction[],
  householdId: number,
  maps: TaxTreatmentMaps,
  toCadMemo: CadConverter,
): Promise<CompletenessTxn[]> {
  const ids = txns.map((t) => t.id);
  const linkedIds = txns
    .map((t) => t.linkedTransactionId)
    .filter((x): x is number => x != null);

  const [pointers, counterparts, corpEntities] = await Promise.all([
    ids.length
      ? Transaction.findAll({
        where: { linkedTransactionId: { [Op.in]: ids } },
        attributes: ['linkedTransactionId'],
      })
      : [],
    linkedIds.length
      ? Transaction.findAll({
        where: { id: { [Op.in]: linkedIds } },
        attributes: ['id', 'entityId'],
      })
      : [],
    Entity.findAll({ where: { householdId, kind: 'corp' }, attributes: ['id'] }),
  ]);

  const linkTargets = new Set(pointers.map((p) => p.linkedTransactionId as number));
  const corpEntityIds = new Set(corpEntities.map((e) => e.id));
  const counterpartEntity = new Map(counterparts.map((c) => [c.id, c.entityId ?? null]));

  const out: CompletenessTxn[] = [];
  for (const t of txns) {
    const counterpart = t.linkedTransactionId != null
      ? counterpartEntity.get(t.linkedTransactionId) ?? null
      : null;
    // Only non-CAD rows pay for a conversion, so the common path stays a plain map.
    const currency = t.currency ?? 'CAD';
    const raw = D(String(t.amount));
    const cadAmount = await toCadMemo(raw, currency, String(t.date));
    out.push({
      id: t.id,
      accountId: t.accountId,
      date: String(t.date),
      amount: String(t.amount),
      txnType: (t as unknown as { txnType?: string | null }).txnType ?? null,
      linkedTransactionId: t.linkedTransactionId ?? null,
      isLinkTarget: linkTargets.has(t.id),
      taxTreatmentOverride: t.taxTreatmentOverride ?? null,
      isTaxClassified: resolveTaxTreatment(t, maps) !== 'none',
      counterpartIsCorp: counterpart !== null && corpEntityIds.has(counterpart),
      cadAmount,
    });
  }
  return out;
}

async function loadActivities(
  accounts: Account[],
  startDate: string,
  endDate: string,
  toCadMemo: CadConverter,
): Promise<ActivityRow[]> {
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return [];
  const accountTypeById = new Map(accounts.map((a) => [a.id, a.accountType ?? '']));
  const [activities, transactions] = await Promise.all([
    InvestmentActivity.findAll({
      where: { accountId: { [Op.in]: accountIds }, tradeDate: { [Op.between]: [startDate, endDate] } },
      order: [['id', 'ASC']],
    }),
    Transaction.findAll({
      where: { accountId: { [Op.in]: accountIds }, date: { [Op.between]: [startDate, endDate] } },
      order: [['id', 'ASC']],
    }),
  ]);
  // The migration's own matcher, so "already in the ledger" means here exactly what it
  // means when that tool decides whether to convert a row.
  const matched = activityIdsWithTransaction(activities, transactions);
  const rows: ActivityRow[] = [];
  for (const a of activities) {
    const amount = a.amount === null || a.amount === undefined ? null : String(a.amount);
    // `InvestmentActivity.currency` is non-null and need not be CAD — USD-listed ETFs
    // are the archetypal case for the eligibility gap that reads these.
    const currency = String((a as unknown as { currency?: unknown }).currency ?? 'CAD');
    const raw = D(amount ?? '0');
    const cadAmount = amount === null
      ? raw
      : await toCadMemo(raw, currency, String(a.tradeDate));
    rows.push({
      id: a.id,
      accountId: a.accountId,
      accountType: accountTypeById.get(a.accountId) ?? '',
      activityType: String(a.activityType),
      amount,
      cadAmount,
      date: String(a.tradeDate),
      securityId: a.securityId ?? null,
      hasTransaction: matched.has(a.id),
    });
  }
  return rows;
}

/**
 * Securities that paid distributions in the period whose eligibility is the default
 * `eligible` and whose asset type means that default is probably wrong.
 */
async function loadUnverifiedEligibility(
  accountIds: number[],
  startDate: string,
  endDate: string,
  toCadMemo: CadConverter,
): Promise<{ securityId: number; symbol: string; amount: string }[]> {
  if (accountIds.length === 0) return [];
  const rows = await InvestmentActivity.findAll({
    where: {
      accountId: { [Op.in]: accountIds },
      tradeDate: { [Op.between]: [startDate, endDate] },
      activityType: { [Op.in]: ['dividend', 'distribution', 'return_of_capital'] },
      securityId: { [Op.ne]: null },
    },
    include: [{ model: Security, as: 'security' }],
  });

  const bySecurity = new Map<number, { symbol: string; total: ReturnType<typeof D> }>();
  for (const r of rows) {
    const security = (r as unknown as { security?: Security | null }).security ?? null;
    if (!security) continue;
    if (security.dividendEligibility !== 'eligible') continue;
    if (!FUND_LIKE_ASSET_TYPES.has(security.assetType ?? null)) continue;
    const existing = bySecurity.get(security.id);
    // USD-listed ETFs are the archetypal case for this very detector.
    const amount = (await toCadMemo(
      D(String(r.amount ?? '0')),
      String((r as unknown as { currency?: unknown }).currency ?? 'CAD'),
      String(r.tradeDate),
    )).abs();
    if (existing) existing.total = existing.total.plus(amount);
    else bySecurity.set(security.id, { symbol: security.symbol, total: amount });
  }

  return [...bySecurity.entries()]
    .filter(([, v]) => v.total.greaterThan(0))
    .map(([securityId, v]) => ({ securityId, symbol: v.symbol, amount: v.total.toFixed(2) }));
}

/**
 * The largest single box on a slip, as a size indicator for the "matches nothing" item.
 *
 * Deliberately not a sum. Summing every box double-counts by construction — a T5008
 * carries box 20 (cost) AND box 21 (proceeds); a T4A carries box 016 AND box 022 (tax
 * deducted) — so the reported figure was not any real quantity. The largest box is at
 * least a number that appears on the slip.
 *
 * Returns null rather than 0.00 when no box parses. A zero here read as "$0.00 is
 * reported on slips with no corresponding transactions", which is a figure standing in
 * for "unknown" — the one thing the figure-presence contract forbids.
 *
 * `Number(v)` was the only place JS number arithmetic reached the money path: a value
 * stored as "1,200.50" became NaN and was silently dropped. Parsing goes through
 * Decimal, and an unparseable box is skipped explicitly.
 */
function largestBox(boxValues: Record<string, unknown>): string | null {
  let largest: Decimal | null = null;
  for (const v of Object.values(boxValues ?? {})) {
    let parsed: Decimal;
    try {
      parsed = D(String(v)).abs();
    } catch {
      continue;
    }
    if (!parsed.isFinite() || parsed.isZero()) continue;
    if (largest === null || parsed.greaterThan(largest)) largest = parsed;
  }
  return largest === null ? null : largest.toFixed(2);
}
