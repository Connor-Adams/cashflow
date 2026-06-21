import { Op } from 'sequelize';
import { ShareholderLoan, Transaction } from '../../models';
import { D, Decimal } from '../util/decimal';

/**
 * Shareholder-loan running balance for a corp entity:
 *   manual(advance + dividend_credit + salary_credit − repayment)
 *   + classified transfers(loan_advance − loan_repayment)
 * Per-transfer dividends/salary are cash distributions and do NOT move the
 * loan balance — only loan_advance/loan_repayment treatments do.
 */
export async function computeShareholderLoanBalance(corpEntityId: number): Promise<Decimal> {
  let balance = D(0);

  const rows = await ShareholderLoan.findAll({ where: { entityId: corpEntityId } });
  for (const r of rows) {
    const amt = D(r.amount);
    balance = r.kind === 'repayment' ? balance.minus(amt) : balance.plus(amt);
  }

  const txns = await Transaction.findAll({
    where: { entityId: corpEntityId, taxTreatmentOverride: { [Op.in]: ['loan_advance', 'loan_repayment'] } },
  });
  for (const t of txns) {
    const amt = D(t.amount as unknown as string).abs();
    balance = t.taxTreatmentOverride === 'loan_repayment' ? balance.minus(amt) : balance.plus(amt);
  }

  return balance;
}
