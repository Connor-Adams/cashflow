/**
 * TypeScript types for the financial scenario planner (issue #213).
 * Mirrors the backend RunScenarioResult and FinancialScenario model shapes.
 */

export type AssumptionType = 'income' | 'expense' | 'savings' | 'one_off'
export type AssumptionRecurrence = 'weekly' | 'biweekly' | 'monthly'

export type ScenarioAssumption = {
  label: string
  type: AssumptionType
  amount: number
  startDate: string
  endDate?: string | null
  recurrence?: AssumptionRecurrence | null
  /** Only used when type === 'one_off'. Defaults to 'out'. */
  direction?: 'in' | 'out' | null
}

export type AssumptionsJson = {
  name: string
  baselineDays?: 30 | 60 | 90
  overrides: ScenarioAssumption[]
}

export type ScenarioForecastSummary = {
  closing: number
  lowest: number
  lowestDate: string | null
  dailyPoints: { date: string; balance: number }[]
}

export type RunScenarioResult = {
  currency: string
  dateFrom: string
  dateTo: string
  baseline: ScenarioForecastSummary
  scenario: ScenarioForecastSummary
  deltas: {
    closing: number
    lowest: number
    lowestDateChanged: boolean
  }
}

export type FinancialScenario = {
  id: number
  householdId: number
  userId: number
  name: string
  assumptionsJson: AssumptionsJson
  resultJson: RunScenarioResult | null
  createdAt: string
  updatedAt: string
}

export type FinancialScenarioListResponse = {
  data: FinancialScenario[]
}

/** Body for POST /api/financial-scenarios */
export type CreateScenarioBody = {
  name: string
  overrides: ScenarioAssumption[]
  baselineDays?: 30 | 60 | 90
}
