import { D, sumD } from '../util/decimal';
import { buildT1 } from './t1';
import { buildT2 } from './t2';
import type {
  CorpTaxYearFacts,
  IncomeItem,
  RateTable,
  ScenarioInput,
  ScenarioResult,
  TaxYearFacts,
} from './types';

export function runScenario(input: ScenarioInput, r: RateTable): ScenarioResult {
  const { ownerComp } = input;

  // Build effective corp facts: deduct salary (reduces ABI), add dividendsPaid
  const corpFacts: CorpTaxYearFacts = {
    ...input.corpFactsBase,
    activeBusinessIncome: [
      ...input.corpFactsBase.activeBusinessIncome,
      ...(ownerComp.salary.greaterThan(0)
        ? [{ source: 'OwnerComp salary deduction', amount: ownerComp.salary.negated(), cadAmount: ownerComp.salary.negated() } satisfies IncomeItem]
        : []),
    ],
    salaryPaid: input.corpFactsBase.salaryPaid.plus(ownerComp.salary),
    dividendsPaid: [
      ...input.corpFactsBase.dividendsPaid,
      ...(ownerComp.eligibleDividends.greaterThan(0)
        ? [{ source: 'Scenario eligible div', date: `${input.year}-12-31`, amount: ownerComp.eligibleDividends, kind: 'eligible' as const }]
        : []),
      ...(ownerComp.nonEligibleDividends.greaterThan(0)
        ? [{ source: 'Scenario non-elig div', date: `${input.year}-12-31`, amount: ownerComp.nonEligibleDividends, kind: 'non_eligible' as const }]
        : []),
    ],
  };

  const corpReturn = buildT2(corpFacts, r);

  // Build effective personal facts: salary becomes employment income; dividends added
  const baseEmp = input.personalFactsBase.employmentIncomeBase;
  const baseElDiv = input.personalFactsBase.eligibleDividendsBase;
  const baseNonElDiv = input.personalFactsBase.nonEligibleDividendsBase;

  const personalFacts: TaxYearFacts = {
    ...input.personalFactsBase,
    employmentIncome: [
      ...baseEmp,
      ...(ownerComp.salary.greaterThan(0)
        ? [{ source: 'OwnerComp T4 salary', amount: ownerComp.salary, cadAmount: ownerComp.salary } satisfies IncomeItem]
        : []),
    ],
    eligibleDividends: [
      ...baseElDiv,
      ...(ownerComp.eligibleDividends.greaterThan(0)
        ? [{ source: 'OwnerComp eligible div', amount: ownerComp.eligibleDividends, cadAmount: ownerComp.eligibleDividends } satisfies IncomeItem]
        : []),
    ],
    nonEligibleDividends: [
      ...baseNonElDiv,
      ...(ownerComp.nonEligibleDividends.greaterThan(0)
        ? [{ source: 'OwnerComp non-elig div', amount: ownerComp.nonEligibleDividends, cadAmount: ownerComp.nonEligibleDividends } satisfies IncomeItem]
        : []),
    ],
  };

  const personalReturn = buildT1(personalFacts, r);

  const corpNetTaxPayable = corpReturn.totals.netTaxPayable;
  const personalTotalPayable = personalReturn.totals.totalPayable;
  const householdTotalTax = corpNetTaxPayable.plus(personalTotalPayable);
  const personalAfterTaxIncome = personalReturn.totals.totalIncome.minus(personalTotalPayable);

  // Effective rate: household tax / pre-draw corp+personal gross income
  // Salary has moved corp→personal, so count once via personal side (ownerComp.salary).
  const corpGross = sumD(corpFacts.activeBusinessIncome.map(i => i.cadAmount))
    .plus(sumD(corpFacts.investmentIncome.interest.map(i => i.cadAmount)))
    .plus(sumD(corpFacts.investmentIncome.eligibleDividends.map(i => i.cadAmount)))
    .plus(sumD(corpFacts.investmentIncome.nonEligibleDividends.map(i => i.cadAmount)))
    .plus(sumD(corpFacts.investmentIncome.rentNet.map(i => i.cadAmount)));
  // Add back the salary deduction so we measure pre-draw gross corp income
  const corpGrossPreDraw = corpGross.plus(ownerComp.salary);
  const personalGrossBase = sumD(baseEmp.map(i => i.cadAmount))
    .plus(sumD(personalFacts.interestIncome.map(i => i.cadAmount)));
  const totalGross = corpGrossPreDraw.plus(personalGrossBase);
  const effectiveRate = totalGross.greaterThan(0) ? householdTotalTax.dividedBy(totalGross) : D('0');

  return {
    ownerComp,
    corpReturn,
    personalReturn,
    combinedTotals: {
      corpNetTaxPayable,
      personalTotalPayable,
      personalAfterTaxIncome,
      householdTotalTax,
      effectiveRate,
    },
  };
}
