import { Op } from 'sequelize';
import {
  Account, Carryforward, Category, Entity, InvestmentActivity, Security, TaxSlip, Transaction,
} from '../../models';
import { D } from '../util/decimal';
import { resolveTaxTreatment, type TaxTreatmentMaps } from '../builders/resolveTaxTreatment';
import { activityIdsWithTransaction } from '../../import/wsDepositActivityMigration';
import { detectDuplicateTransactions } from '../../import/detectDuplicateTransactions';
import { DETECTORS } from './detectors';
import { worstStatus } from './status';
import type { RateTable, TaxYearFacts } from '../engine/types';
import type {
  AccountRow, ActivityRow, CompletenessContext, CompletenessReport, CompletenessTxn,
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

/** Slip types `buildT1` actually reads. Anything else is entered and ignored. */
const SLIP_TYPES_THE_ENGINE_READS = new Set(['T4', 'T5', 'T3']);

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

  const personalTxns = await toCompletenessTxns(txns, householdId, maps);
  const accountIds = accounts.map((a) => a.id);
  const activities = await loadActivities(accountIds, startDate, endDate);

  const ctx: CompletenessContext = {
    entityId,
    year,
    facts,
    rates,
    personalTxns,
    unimportedOutboundTransfers: await loadUnimportedOutboundTransfers(householdId, year),
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
        amount: sumBoxes(s.boxValues as Record<string, unknown>),
      })),
    unverifiedEligibility: await loadUnverifiedEligibility(accountIds, startDate, endDate),
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

  return txns.map((t): CompletenessTxn => {
    const counterpart = t.linkedTransactionId != null
      ? counterpartEntity.get(t.linkedTransactionId) ?? null
      : null;
    return {
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
      cadAmount: D(String((t as unknown as { cadAmount?: unknown }).cadAmount ?? t.amount)),
    };
  });
}

async function loadActivities(
  accountIds: number[],
  startDate: string,
  endDate: string,
): Promise<ActivityRow[]> {
  if (accountIds.length === 0) return [];
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
  return activities.map((a): ActivityRow => ({
    id: a.id,
    accountId: a.accountId,
    activityType: String(a.activityType),
    amount: a.amount === null || a.amount === undefined ? null : String(a.amount),
    date: String(a.tradeDate),
    securityId: a.securityId ?? null,
    hasTransaction: matched.has(a.id),
  }));
}

/**
 * Securities that paid distributions in the period whose eligibility is the default
 * `eligible` and whose asset type means that default is probably wrong.
 */
async function loadUnverifiedEligibility(
  accountIds: number[],
  startDate: string,
  endDate: string,
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
    const amount = D(String(r.amount ?? '0')).abs();
    if (existing) existing.total = existing.total.plus(amount);
    else bySecurity.set(security.id, { symbol: security.symbol, total: amount });
  }

  return [...bySecurity.entries()]
    .filter(([, v]) => v.total.greaterThan(0))
    .map(([securityId, v]) => ({ securityId, symbol: v.symbol, amount: v.total.toFixed(2) }));
}

/** Total of a slip's numeric boxes, for the "matches nothing" figure. */
function sumBoxes(boxValues: Record<string, unknown>): string {
  let total = D('0');
  for (const v of Object.values(boxValues ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n)) total = total.plus(D(String(n)).abs());
  }
  return total.toFixed(2);
}
