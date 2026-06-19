import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Tabs } from '../components/ui/tabs'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { YearJump } from '../components/tax/YearJump'
import { OverviewTab } from './tax/OverviewTab'
import { PersonalT1Tab } from './tax/PersonalT1Tab'
import { SlipsTab } from './tax/SlipsTab'
import { ReconciliationTab } from './tax/ReconciliationTab'
import { CorpT2Tab } from './tax/CorpT2Tab'
import { ShareholderLoanTab } from './tax/ShareholderLoanTab'
import { OwnerCompPlannerTab } from './tax/OwnerCompPlannerTab'
import { TaxHygieneTab } from './tax/TaxHygieneTab'
import { TaxReserveTab } from './tax/TaxReserveTab'
import { ClassifyTab } from './tax/ClassifyTab'
import { ClassifiedTab } from './tax/ClassifiedTab'
import { useTaxYears } from '../hooks/useTaxYears'

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'personal', label: 'Personal T1' },
  { value: 'slips', label: 'Slips' },
  { value: 'reconciliation', label: 'Reconciliation' },
  { value: 'classify', label: 'Classify' },
  { value: 'classified', label: 'Classified' },
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

function isTextInput(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT' && (el as HTMLInputElement).type === 'text') return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

export function TaxPage() {
  const [tab, setTab] = useState('overview')
  const { years, error: yearsError } = useTaxYears()
  const [year, setYear] = useState<number | null>(null)
  const [activePlanId, setActivePlanId] = useState<number | null>(null)
  const yearInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (year === null && years && years.length > 0) {
      setYear(pickDefaultYear(years))
    }
  }, [years, year])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        if (isTextInput(document.activeElement)) return
        e.preventDefault()
        yearInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <section>
      <header className="flex items-baseline gap-4">
        <h1>Tax</h1>
        {years && year !== null && (
          <YearJump
            ref={yearInputRef}
            years={years}
            value={year}
            onChange={setYear}
          />
        )}
        {yearsError && <span className="error">Failed to load years: {yearsError}</span>}
      </header>
      {years && years.length === 0 ? (
        <EmptyState
          title="No tax years yet"
          description="Import transactions for a tax year and your slips, returns, and reconciliation will populate here."
          actions={
            <Button asChild size="sm">
              <Link to="/import">Import a statement</Link>
            </Button>
          }
        />
      ) : (
        <>
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
          {tab === 'classify' && <ClassifyTab year={year} />}
          {tab === 'classified' && <ClassifiedTab year={year} />}
          {tab === 'corp' && <CorpT2Tab />}
          {tab === 'shareholder-loans' && <ShareholderLoanTab />}
          {tab === 'planner' && <OwnerCompPlannerTab activePlanId={activePlanId} />}
          {tab === 'hygiene' && <TaxHygieneTab year={year} />}
          {tab === 'reserve' && <TaxReserveTab year={year} />}
        </>
      )}
        </>
      )}
    </section>
  )
}
