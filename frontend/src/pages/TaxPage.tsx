import { useEffect, useRef, useState } from 'react'
import { Tabs } from '../components/ui/tabs'
import { OverviewTab } from './tax/OverviewTab'
import { PersonalT1Tab } from './tax/PersonalT1Tab'
import { SlipsTab } from './tax/SlipsTab'
import { ReconciliationTab } from './tax/ReconciliationTab'
import { CorpT2Tab } from './tax/CorpT2Tab'
import { ShareholderLoanTab } from './tax/ShareholderLoanTab'
import { OwnerCompPlannerTab } from './tax/OwnerCompPlannerTab'
import { TaxHygieneTab } from './tax/TaxHygieneTab'
import { TaxReserveTab } from './tax/TaxReserveTab'
import { useTaxYears } from '../hooks/useTaxYears'

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'personal', label: 'Personal T1' },
  { value: 'slips', label: 'Slips' },
  { value: 'reconciliation', label: 'Reconciliation' },
  { value: 'corp', label: 'Corp T2' },
  { value: 'shareholder-loans', label: 'Shareholder Loans' },
  { value: 'planner', label: 'Owner Comp' },
  { value: 'hygiene', label: 'Business Hygiene' },
  { value: 'reserve', label: 'Reserve' },
]

function pickDefaultYear(years: number[]): number {
  const prev = new Date().getUTCFullYear() - 1
  if (years.includes(prev)) return prev
  return years[years.length - 1]
}

export function TaxPage() {
  const [tab, setTab] = useState('overview')
  const { years, error: yearsError } = useTaxYears()
  const [year, setYear] = useState<number | null>(null)
  // Active household plan id is lifted here so the picker on Overview and the
  // OwnerCompPlannerTab consumer stay in sync without prop-drilling through
  // a context. TaxPage already keeps tab + year state with `useState`, so a
  // local `useState` here matches the prevailing pattern (URL query params
  // would be cleaner if tab state already used them, but it doesn't).
  const [activePlanId, setActivePlanId] = useState<number | null>(null)
  const yearSelectRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    if (year === null && years && years.length > 0) {
      setYear(pickDefaultYear(years))
    }
  }, [years, year])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        yearSelectRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h1>Tax</h1>
        {years && year !== null && (
          <label>
            Year{' '}
            <select
              ref={yearSelectRef}
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="Tax year (Cmd+K to focus)"
              title="Tax year — press Cmd+K (or Ctrl+K) to jump here from anywhere"
            >
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
        )}
        {yearsError && <span className="error">Failed to load years: {yearsError}</span>}
      </header>
      <Tabs items={TABS} value={tab} onValueChange={setTab} />
      {year === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {tab === 'overview' && (
            <OverviewTab
              year={year}
              activePlanId={activePlanId}
              onPlanChange={setActivePlanId}
            />
          )}
          {tab === 'personal' && <PersonalT1Tab year={year} />}
          {tab === 'slips' && <SlipsTab year={year} />}
          {tab === 'reconciliation' && <ReconciliationTab year={year} />}
          {tab === 'corp' && <CorpT2Tab />}
          {tab === 'shareholder-loans' && <ShareholderLoanTab />}
          {tab === 'planner' && <OwnerCompPlannerTab activePlanId={activePlanId} />}
          {tab === 'hygiene' && <TaxHygieneTab year={year} />}
          {tab === 'reserve' && <TaxReserveTab year={year} />}
        </>
      )}
    </section>
  )
}
