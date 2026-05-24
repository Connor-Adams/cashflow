import { type Decimal } from '../util/decimal';

export type Instalment = { dueOn: string; amount: Decimal };

const DUE_DATES = ['03-15', '06-15', '09-15', '12-15'];

export function quarterlyInstalments(annualOwing: Decimal, year: number = new Date().getUTCFullYear()): Instalment[] {
  const per = annualOwing.dividedBy(4);
  return DUE_DATES.map((md) => ({ dueOn: `${year}-${md}`, amount: per }));
}
