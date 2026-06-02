import { TAX_TREATMENTS } from '@cashflow/shared'
import type { TaxTreatment } from '@cashflow/shared'

export { TAX_TREATMENTS, type TaxTreatment }

export const TREATMENT_LABELS: Record<TaxTreatment, string> = {
  none: 'Default (none)',
  employment_income: 'Employment income',
  donations: 'Donation',
  rrsp_contribution: 'RRSP contribution',
  fhsa_contribution: 'FHSA contribution',
  eligible_dividend: 'Eligible dividend',
  non_eligible_dividend: 'Non-eligible dividend',
  salary: 'Salary',
  loan_advance: 'Shareholder loan advance',
  loan_repayment: 'Shareholder loan repayment',
  not_income: 'Not income',
}

export const CORP_OPTIONS: TaxTreatment[] = [
  'eligible_dividend',
  'non_eligible_dividend',
  'salary',
  'loan_advance',
  'loan_repayment',
  'not_income',
]

export const PAYROLL_OPTIONS: TaxTreatment[] = ['employment_income', 'not_income']
