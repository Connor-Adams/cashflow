import { Op } from 'sequelize';
import { Account } from '../models/Account';
import { Household } from '../models/Household';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { PortfolioDailySnapshot } from '../models/PortfolioDailySnapshot';
import { Security } from '../models/Security';
import { SecurityDailyPrice } from '../models/SecurityDailyPrice';
import { HoldingSnapshot } from '../models/HoldingSnapshot';
import { FxRate } from '../models/FxRate';
import { toUnits, fromUnits } from '../util/numbers';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// How many calendar days a daily price may be carried forward before the
// position is treated as unpriced. Keeps a position valued across weekends,
// holidays and short feed gaps without resurrecting arbitrarily stale prices.
const CARRY_FORWARD_MAX_DAYS = 10;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return toIsoDate(new Date(new Date(iso).getTime() + days * MS_PER_DAY));
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / MS_PER_DAY);
}

// Latest element (by ascending `date`) whose date is <= `d`, or null. Binary search.
function floorByDate<T extends { date: string }>(arr: T[] | undefined, d: string): T | null {
  if (!arr || arr.length === 0) return null;
  let lo = 0;
  let hi = arr.length - 1;
  let res: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].date <= d) {
      res = arr[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

// Apply an activity's quantity delta to the running per-(account,security) map.
function applyActivityQty(qty: Map<string, number>, a: InvestmentActivity): void {
  if (a.securityId == null) return;
  const key = `${a.accountId}:${a.securityId}`;
  const cur = qty.get(key) ?? 0;
  const qChange = Number(a.quantity ?? '0');
  if (a.activityType === 'buy' || a.activityType === 'reinvestment') {
    qty.set(key, cur + qChange);
  } else if (a.activityType === 'sell') {
    qty.set(key, cur - qChange);
  } else if (a.activityType === 'transfer' && qChange > 0) {
    qty.set(key, cur + qChange);
  }
}

export interface BuildDailySnapshotsArgs {
  householdId: number;
  fromDate?: string;
  toDate?: string;
}

export interface BuildResult {
  daysBuilt: number;
  daysSkipped: number;
  partialDays: number;
  errors: string[];
}

async function resolveDateRange(
  householdId: number,
  fromDate: string | undefined,
  toDate: string | undefined,
): Promise<{ from: string; to: string } | null> {
  const to = toDate ?? toIsoDate(new Date(Date.now() - MS_PER_DAY));
  if (fromDate) return { from: fromDate, to };

  const lastSnap = await PortfolioDailySnapshot.findOne({
    where: { householdId },
    order: [['date', 'DESC']],
  });
  if (lastSnap) {
    return { from: addDays(lastSnap.date, 1), to };
  }

  const accounts = await Account.findAll({ where: { householdId, accountType: 'investment' }, attributes: ['id'] });
  if (accounts.length === 0) return null;
  const acctIds = accounts.map((a) => a.id);
  const earliest = await InvestmentActivity.findOne({
    where: { accountId: { [Op.in]: acctIds } },
    order: [['tradeDate', 'ASC']],
  });
  if (!earliest) return null;
  return { from: earliest.tradeDate, to };
}

export async function buildDailySnapshotsForHousehold(args: BuildDailySnapshotsArgs): Promise<BuildResult> {
  const { householdId } = args;
  const range = await resolveDateRange(householdId, args.fromDate, args.toDate);
  if (!range) return { daysBuilt: 0, daysSkipped: 0, partialDays: 0, errors: [] };
  const { from, to } = range;

  const accounts = await Account.findAll({ where: { householdId, accountType: 'investment' } });
  if (accounts.length === 0) return { daysBuilt: 0, daysSkipped: 0, partialDays: 0, errors: [] };
  const acctIds = accounts.map((a) => a.id);

  const allActivities = await InvestmentActivity.findAll({
    where: { accountId: { [Op.in]: acctIds }, tradeDate: { [Op.lte]: to } },
    order: [['tradeDate', 'ASC']],
  });

  const touchedSecurityIds = [...new Set(
    allActivities.map((a) => a.securityId).filter((id): id is number => id != null),
  )];
  const securities = touchedSecurityIds.length > 0
    ? await Security.findAll({ where: { id: { [Op.in]: touchedSecurityIds } } })
    : [];
  const secById = new Map(securities.map((s) => [s.id, s]));

  const allPrices = touchedSecurityIds.length > 0
    ? await SecurityDailyPrice.findAll({
        where: { securityId: { [Op.in]: touchedSecurityIds }, date: { [Op.lte]: to } },
      })
    : [];
  const priceByKey = new Map<string, number>();
  // Per-security ascending [date, price] arrays for carry-forward lookups.
  const pricesBySec = new Map<number, Array<{ date: string; price: number }>>();
  for (const p of allPrices) {
    priceByKey.set(`${p.securityId}:${p.date}`, Number(p.adjClose));
    const arr = pricesBySec.get(p.securityId) ?? [];
    arr.push({ date: p.date, price: Number(p.adjClose) });
    pricesBySec.set(p.securityId, arr);
  }
  for (const arr of pricesBySec.values()) {
    arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // Broker-reported holding values, used as a last-resort fallback when a held
  // security has no daily price (e.g. mutual funds, cash ETFs). Keyed by
  // `${accountId}:${securityId}`, ascending by statement date.
  const allHoldings = touchedSecurityIds.length > 0
    ? await HoldingSnapshot.findAll({
        where: {
          accountId: { [Op.in]: acctIds },
          securityId: { [Op.in]: touchedSecurityIds },
          statementDate: { [Op.lte]: to },
        },
      })
    : [];
  const holdingsByKey = new Map<string, Array<{ date: string; marketValue: number }>>();
  for (const h of allHoldings) {
    if (h.securityId == null || h.marketValue == null) continue;
    const k = `${h.accountId}:${h.securityId}`;
    const arr = holdingsByKey.get(k) ?? [];
    arr.push({ date: h.statementDate, marketValue: Number(h.marketValue) });
    holdingsByKey.set(k, arr);
  }
  for (const arr of holdingsByKey.values()) {
    arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // Account currency comes from defaultCurrency (maps to `default_currency` column).
  // Fall back to 'CAD' if unset.
  const accountCurrencies = [
    ...new Set(accounts.map((a) => a.defaultCurrency ?? 'CAD').filter((c) => c !== 'CAD')),
  ];
  const allFx = accountCurrencies.length > 0
    ? await FxRate.findAll({
        where: { fromCurrency: { [Op.in]: accountCurrencies }, toCurrency: 'CAD', ratedDate: { [Op.lte]: to } },
      })
    : [];
  const fxByKey = new Map<string, number>();
  for (const f of allFx) {
    fxByKey.set(`${f.fromCurrency}:${f.ratedDate}`, Number(f.rate));
  }

  // Running qty per (accountId, securityId).
  const qty = new Map<string, number>();
  const activitiesByDate = new Map<string, InvestmentActivity[]>();
  for (const a of allActivities) {
    // Seed positions opened before the build window so a narrow/incremental
    // range still values them (allActivities is ordered by tradeDate ASC).
    if (a.tradeDate < from) {
      applyActivityQty(qty, a);
      continue;
    }
    const list = activitiesByDate.get(a.tradeDate) ?? [];
    list.push(a);
    activitiesByDate.set(a.tradeDate, list);
  }

  let daysBuilt = 0;
  let partialDays = 0;
  const errors: string[] = [];
  const now = new Date();

  for (let d = from; d <= to; d = addDays(d, 1)) {
    // Apply today's activities to qty map BEFORE valuing.
    const todays = activitiesByDate.get(d) ?? [];
    for (const a of todays) {
      applyActivityQty(qty, a);
    }

    let dayHasPartial = false;
    for (const acct of accounts) {
      const acctCurrency = acct.defaultCurrency ?? 'CAD';
      let mvNativeU = 0;
      const reasons: string[] = [];

      const heldKeys = [...qty.keys()].filter((k) => k.startsWith(`${acct.id}:`));
      for (const key of heldKeys) {
        const q = qty.get(key) ?? 0;
        if (q === 0) continue;
        const securityId = Number(key.split(':')[1]);
        const sec = secById.get(securityId);
        const symbol = sec?.symbol ?? `sec_${securityId}`;

        // 1. Exact daily price for the day.
        const exact = priceByKey.get(`${securityId}:${d}`);
        if (exact != null) {
          mvNativeU += toUnits(q * exact);
          continue;
        }

        // 2. Carry forward the most recent price within the staleness window.
        const carried = floorByDate(pricesBySec.get(securityId), d);
        if (carried != null && daysBetween(carried.date, d) <= CARRY_FORWARD_MAX_DAYS) {
          mvNativeU += toUnits(q * carried.price);
          reasons.push(`stale_price:${symbol}@${carried.date}`);
          continue;
        }

        // 3. Fall back to the broker-reported holding value (mutual funds, cash
        //    ETFs and anything without a daily price feed).
        const broker = floorByDate(holdingsByKey.get(key), d);
        if (broker != null) {
          mvNativeU += toUnits(broker.marketValue);
          reasons.push(`broker_value:${symbol}`);
          continue;
        }

        // 4. Unpriced: contributes nothing and flags the day partial.
        reasons.push(`no_price:${symbol}`);
      }

      let fxRate = 1;
      if (acctCurrency !== 'CAD') {
        const lookup = fxByKey.get(`${acctCurrency}:${d}`);
        if (lookup == null) {
          reasons.push(`no_fx:${acctCurrency}`);
        } else {
          fxRate = lookup;
        }
      }

      const cashFlowNative = fromUnits(todays
        .filter((a) => a.accountId === acct.id && a.activityType === 'transfer')
        .reduce((s, a) => s + toUnits(Number(a.amount ?? '0')), 0));

      const mvNative = fromUnits(mvNativeU);
      const mvCad = mvNative * fxRate;
      const cashFlowCad = cashFlowNative * fxRate;
      const isPartial = reasons.length > 0;
      if (isPartial) dayHasPartial = true;

      try {
        await PortfolioDailySnapshot.upsert(
          {
            householdId,
            accountId: acct.id,
            date: d,
            marketValueNative: String(mvNative.toFixed(4)),
            currency: acctCurrency,
            fxRateToCad: String(fxRate.toFixed(6)),
            marketValueCad: String(mvCad.toFixed(4)),
            cashFlowNative: String(cashFlowNative.toFixed(4)),
            cashFlowCad: String(cashFlowCad.toFixed(4)),
            isPartial,
            missingDataReasons: isPartial ? reasons : null,
            computedAt: now,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { conflictFields: ['household_id', 'account_id', 'date'] as any },
        );
      } catch (err) {
        errors.push(`upsert failed for ${acct.id}:${d}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (dayHasPartial) partialDays++;
    daysBuilt++;
  }

  return { daysBuilt, daysSkipped: 0, partialDays, errors };
}

export async function buildDailySnapshotsForAllHouseholds(args?: { toDate?: string }): Promise<{
  households: number;
  daysBuilt: number;
  daysSkipped: number;
  partialDays: number;
}> {
  const households = await Household.findAll({ attributes: ['id'] });
  let daysBuilt = 0;
  let daysSkipped = 0;
  let partialDays = 0;
  for (const hh of households) {
    const r = await buildDailySnapshotsForHousehold({ householdId: hh.id, toDate: args?.toDate });
    daysBuilt += r.daysBuilt;
    daysSkipped += r.daysSkipped;
    partialDays += r.partialDays;
  }
  return { households: households.length, daysBuilt, daysSkipped, partialDays };
}

export async function markDailySnapshotsStaleForHousehold(householdId: number, fromDate: string): Promise<void> {
  await PortfolioDailySnapshot.destroy({
    where: { householdId, date: { [Op.gte]: fromDate } },
  });
}
