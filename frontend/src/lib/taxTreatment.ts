import { TAX_TREATMENTS } from '@cashflow/shared'
import type { TaxTreatment } from '@cashflow/shared'

export { TAX_TREATMENTS, type TaxTreatment }

export const TREATMENT_LABELS: Record<TaxTreatment, string> = {
  none: 'Default (none)',
  employment_income: 'Employment income',
  donations: 'Donation',
  rrsp_contribution: 'RRSP contribution',
  fhsa_contribution: 'FHSA contribution',
}
