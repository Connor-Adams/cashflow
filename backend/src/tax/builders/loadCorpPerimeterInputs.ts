import { Op } from 'sequelize';
import { Account, Entity, InvestmentActivity, Transaction } from '../../models';
import type { PerimeterOptions, PerimeterTxn } from './corpPerimeter';

/** Shift a 'YYYY-MM-DD' date by whole days, staying in UTC. */
function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Everything the corp perimeter split needs, plus the rows its callers go on to
 * read. Assembled once so `buildCorpFacts` and the completeness gate partition
 * the SAME perimeter: re-deriving these inputs is how the two would drift.
 */
export interface CorpPerimeterInputs {
  entity: Entity;
  accountIds: number[];
  /** Every entity transaction in the fiscal window, id-ascending. */
  txns: Transaction[];
  /** `perimeterTxns` mapped for `partitionCorpPerimeter`. */
  perimeterInput: PerimeterTxn[];
  /** The second argument to `partitionCorpPerimeter`, so both callers pass one identical object. */
  perimeterOptions: PerimeterOptions;
  /** Surplus-mirror warnings, for the caller to fold into its own warning list. */
  mirrorWarnings: string[];
}

export async function loadCorpPerimeterInputs(
  entityId: number,
  fiscalYear: { startDate: string; endDate: string },
): Promise<CorpPerimeterInputs> {
  const entity = await Entity.findByPk(entityId);
  if (!entity) throw new Error(`Entity ${entityId} not found`);
  if (entity.kind !== 'corp') throw new Error(`Entity ${entityId} is not corp`);

  const { startDate, endDate } = fiscalYear;

  const accounts = await Account.findAll({ where: { entityId } });
  const accountIds = accounts.map((a) => a.id);

  const txns = await Transaction.findAll({
    // Ordered so the mirror exclusion below claims deterministically: two rows at
    // one key can differ in txnType, treatment, link and merchant, and whichever
    // survives is what reaches the perimeter split.
    order: [['id', 'ASC']],
    where: { entityId, date: { [Op.between]: [startDate, endDate] } },
  });

  // Active business income — money that actually crossed the corporate
  // perimeter, in or out. A single customer payment can occupy several rows as
  // it hops between the corp's own accounts; only the hop that enters from
  // outside is income. `corpPerimeter` owns that rule and documents why
  // `linkedTransactionId` alone cannot detect an internal leg.
  //
  // The link-target set is built from the entity's FULL history, not the fiscal
  // window: a transfer initiated in December and settled in January would
  // otherwise look external on both sides of the year boundary.
  const allEntityTxns = await Transaction.findAll({
    where: { entityId },
    attributes: ['id', 'linkedTransactionId'],
  });
  const linkTargetIds = new Set<number>();
  for (const t of allEntityTxns) {
    if (t.linkedTransactionId != null) linkTargetIds.add(t.linkedTransactionId);
  }

  const accountTypeById = new Map(accounts.map((a) => [a.id, a.accountType ?? null]));

  // Cash moving between a bank account and the corp's own brokerage is recorded
  // on the brokerage side as an InvestmentActivity row, never as a transaction,
  // so `linkedTransactionId` (an FK into transactions) can never reach it. Feed
  // those movements to the perimeter split so such a transfer is recognised as
  // internal instead of being reported as unexplained. Widened past the fiscal
  // year by the same few days the matcher tolerates, so a transfer initiated in
  // late December and settled in January still finds its far side.
  const cashMoves = accountIds.length
    ? await InvestmentActivity.findAll({
      where: {
        accountId: accountIds,
        activityType: ['transfer_in', 'transfer_out', 'deposit', 'withdrawal'],
        tradeDate: { [Op.between]: [shiftDays(startDate, -3), shiftDays(endDate, 3)] },
      },
    })
    : [];
  const internalCashMoves = cashMoves.map((a) => ({
    date: a.tradeDate as unknown as string,
    amount: String(a.amount ?? 0),
    currency: (a as unknown as { currency?: string }).currency ?? 'CAD',
  }));

  // The brokerage cash mirror (part 1a) is a plain transaction on an investment
  // account that exists only because an InvestmentActivity exists. The perimeter
  // split has never seen such a row: a POSITIVE one cannot be claimed by
  // `claimMatchingCashMove` — that needs an opposite sign and the activity is
  // positive too — so it falls through to `revenue.push` as phantom active
  // business income. A negative one lands in `expenses` as a phantom deduction.
  //
  // Keyed on the activity feed rather than on `txnType`, because the allowlisted
  // Wealthsimple codes are absent from CASH_CODE_TXN_TYPE and a forward-fix mirror
  // carries the statement's own import batch, not the converter's label — so
  // neither type nor provenance identifies it. An activity at the same account,
  // date, amount and currency does, whatever produced the mirror.
  //
  // Its own query, deliberately: `cashMoves` above omits `cash_movement`, and
  // widening it would also widen `internalCashMoves` and move corp totals for
  // unrelated reasons.
  const mirrorActivities = accountIds.length
    ? await InvestmentActivity.findAll({
      where: {
        accountId: accountIds,
        activityType: ['transfer_in', 'transfer_out', 'cash_movement'],
        tradeDate: { [Op.between]: [startDate, endDate] },
      },
    })
    : [];
  const mirrorKey = (accountId: number, date: string, amount: string, currency: string) =>
    `${accountId}|${String(date).slice(0, 10)}|${Number(amount).toFixed(4)}|${(currency || 'CAD').toUpperCase()}`;
  const unclaimedMirrors = new Map<string, number>();
  for (const a of mirrorActivities) {
    const k = mirrorKey(
      a.accountId as number,
      a.tradeDate as unknown as string,
      String(a.amount ?? 0),
      (a as unknown as { currency?: string }).currency ?? 'CAD',
    );
    unclaimedMirrors.set(k, (unclaimedMirrors.get(k) ?? 0) + 1);
  }

  // Claim 1:1. A bare match would let one activity drop every transaction at that
  // key, which on a brokerage account is exactly the collision this codebase
  // declines to act on elsewhere — and dropping a real corp revenue row silently
  // would be that same mistake with the sign flipped. A surplus stays in.
  const mirrorWarnings: string[] = [];
  /** Keys where a mirror was already claimed, so a further hit is a real surplus. */
  const seenMirrorKeys = new Set<string>();
  const perimeterTxns = txns.filter((t) => {
    if ((accountTypeById.get(t.accountId) ?? null) !== 'investment') return true;
    const k = mirrorKey(
      t.accountId,
      t.date as unknown as string,
      String(t.amount),
      t.currency ?? 'CAD',
    );
    const left = unclaimedMirrors.get(k) ?? 0;
    if (left <= 0) {
      // Warn only on a genuine SURPLUS — more transactions at a key than there are
      // activities to explain them. A key with no activity at all is the ordinary
      // case on a brokerage account: all twelve CASH_TXN_CODES (SPEND, DCTFEE,
      // OBP, …) already produce cash rows there, and warning on each would emit
      // one per row and drown part 3's blocker list.
      if (seenMirrorKeys.has(k)) {
        mirrorWarnings.push(
          `Txn #${t.id} on investment account ${t.accountId} was counted by the corp `
          + 'perimeter: more transactions share its date and amount than there are '
          + 'investment activities to explain them.',
        );
      }
      return true;
    }
    seenMirrorKeys.add(k);
    unclaimedMirrors.set(k, left - 1);
    return false;
  });

  const perimeterInput: PerimeterTxn[] = perimeterTxns.map((t) => ({
    id: t.id,
    amount: String(t.amount),
    currency: t.currency ?? 'CAD',
    date: t.date as unknown as string,
    txnType: (t as unknown as { txnType?: string | null }).txnType ?? null,
    accountType: accountTypeById.get(t.accountId) ?? null,
    linkedTransactionId: t.linkedTransactionId ?? null,
    taxTreatmentOverride: t.taxTreatmentOverride ?? null,
    merchant: t.merchantClean ?? t.merchantRaw ?? null,
  }));

  // Only what a caller actually consumes. `accounts`, `accountTypeById`,
  // `perimeterTxns`, `linkTargetIds` and `internalCashMoves` are intermediate state:
  // returning them would publish a contract nothing reads, and the last two are
  // already inside `perimeterOptions`.
  return {
    entity,
    accountIds,
    txns,
    perimeterInput,
    perimeterOptions: { legalName: entity.legalName ?? '', linkTargetIds, internalCashMoves },
    mirrorWarnings,
  };
}
