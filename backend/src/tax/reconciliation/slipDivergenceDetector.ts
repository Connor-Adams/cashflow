import { Op } from 'sequelize';
import { TaxSlip, Transaction } from '../../models';
import { D, sumD } from '../util/decimal';
import type { ReconciliationFinding } from './types';

const DIVERGENCE_THRESHOLD = D('50');

/**
 * Compare slip box totals against categorised transaction totals for the year.
 * Initial scope: T4 box14 vs sum(employment_income txns).
 */
export async function detectSlipDivergence(
  entityId: number,
  year: number,
): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const t4Slips = await TaxSlip.findAll({
    where: { entityId, year, slipType: 'T4' },
  });
  const employmentTxns = await Transaction.findAll({
    where: {
      entityId,
      date: { [Op.between]: [yearStart, yearEnd] },
      finalCategory: 'employment_income',
    },
  });

  if (t4Slips.length === 0 && employmentTxns.length === 0) return findings;

  const slipTotal = sumD(
    t4Slips.map((s) => {
      const box14 = (s.boxValues as Record<string, number | string> | undefined)?.box14;
      return box14 != null ? D(String(box14)) : D('0');
    }),
  );
  const txnTotal = sumD(employmentTxns.map((t) => D(t.amount as unknown as string)));

  const diff = slipTotal.minus(txnTotal).abs();
  if (diff.greaterThan(DIVERGENCE_THRESHOLD)) {
    findings.push({
      category: 'slip_divergence',
      severity: 'warning',
      subjectRef: `T4 box14 vs employment_income txns for ${year}`,
      message:
        `T4 box14 total ${slipTotal.toFixed(2)} differs from categorised ` +
        `employment_income transactions ${txnTotal.toFixed(2)} by ${diff.toFixed(2)}.`,
      details: {
        slipType: 'T4',
        box: 'box14',
        slipTotal: slipTotal.toFixed(2),
        txnTotal: txnTotal.toFixed(2),
        diff: diff.toFixed(2),
      },
    });
  }

  return findings;
}
