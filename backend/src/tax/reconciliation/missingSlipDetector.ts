import { Op } from 'sequelize';
import { TaxSlip, Transaction } from '../../models';
import type { ReconciliationFinding } from './types';

/**
 * Detect transactions whose category implies a slip should exist for the
 * year but no matching slip is recorded. Initial scope: employment_income → T4.
 */
export async function detectMissingSlips(
  entityId: number,
  year: number,
): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const employmentTxns = await Transaction.findAll({
    where: {
      entityId,
      date: { [Op.between]: [yearStart, yearEnd] },
      finalCategory: 'employment_income',
    },
  });

  if (employmentTxns.length === 0) return findings;

  const t4Count = await TaxSlip.count({
    where: { entityId, year, slipType: 'T4' },
  });

  if (t4Count === 0) {
    findings.push({
      category: 'missing_slip',
      severity: 'warning',
      subjectRef: `${employmentTxns.length} employment_income txn(s) in ${year}`,
      message: `Employment-income transactions exist but no T4 slip recorded for ${year}.`,
      details: {
        slipType: 'T4',
        txnCount: employmentTxns.length,
        txnIds: employmentTxns.map((t) => t.id),
      },
    });
  }

  return findings;
}
