import { useCallback, useEffect, useRef, useState } from 'react'
import { Tabs } from '../components/ui/tabs'
import { YearJump, type YearJumpHandle } from '../components/tax/YearJump'
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

const HINT_KEY = 'cashflow.tax.cmdKHintSeen'

function pickDefaultYear(years: number[]): number {
  const prev = new Date().getUTCFullYear() - 1
  if (years.includes(prev)) return prev
  return years[years.length - 1]
}

function isTextInput(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type.toLowerCase()
    return type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === 'number' || type === 'password'
  }
  return (el as HTMLElement).isContentEditable
}

export function TaxPage() {
  const [tab, setTab] = useState('overview')
  const { years, error: yearsError } = useTaxYears()
  const [year, setYear] = useState<number | null>(null)
  const [activePlanId, setActivePlanId] = useState<number | null>(null)
  const [tabNotFound, setTabNotFound] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const yearJumpRef = useRef<YearJumpHandle>(null)

  useEffect(() => {
    if (year === null && years && years.length > 0) {
      setYear(pickDefaultYear(years))
    }
  }, [years, year])

  // Reset the 404 indicator whenever the year or tab changes.
  useEffect(() => { setTabNotFound(false) }, [year, tab])

  // Show the Cmd-K hint once on first visit to TaxPage.
  useEffect(() => {
    if (!localStorage.getItem(HINT_KEY)) {
      setShowHint(true)
      localStorage.setItem(HINT_KEY, '1')
      const t = setTimeout(() => setShowHint(false), 4000)
      return () => clearTimeout(t)
    }
  }, [])

  const stepYear = useCallback((delta: number) => {
    if (!years || year === null) return
    const idx = years.indexOf(year)
    const next = years[idx + delta]
    if (next !== undefined) setYear(next)
  }, [years, year])

  // Ctrl+Left / Ctrl+Right navigate between years without grabbing the
  // arrow keys that the Tabs component uses for tab switching.
  // Ctrl/Cmd+K focuses the year combobox — guard against firing from text inputs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepYear(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); stepYear(1) }
      if (e.key === 'k' || e.key === 'K') {
        if (isTextInput(document.activeElement)) return
        e.preventDefault()
        yearJumpRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepYear])

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h1>Tax</h1>
        {years && years.length > 0 && year !== null ? (
          <label className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">Year</span>
            <YearJump ref={yearJumpRef} years={years} value={year} onChange={setYear} />
            <span className="text-xs text-muted-foreground" title="Ctrl+Left / Ctrl+Right · Ctrl+K to jump">⌃←→ ⌃K</span>
          </label>
        ) : null}
        {yearsError && (
          <span role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            Failed to load years: {yearsError}
          </span>
        )}
        {years && years.length === 0 && !yearsError && (
          <span className="text-sm text-muted-foreground">
            No tax years found — import transactions to get started.
          </span>
        )}
      </header>
      {showHint && (
        <p className="mt-1 text-xs text-muted-foreground" role="status" aria-live="polite">
          Press Cmd-K to jump to a year.
        </p>
      )}
      <Tabs items={TABS} value={tab} onValueChange={setTab} className="mt-4" />
      {tabNotFound && year !== null && (
        <p role="alert" className="mt-3 text-sm text-muted-foreground">
          No data for {year} in this view. Try a different year or import transactions.
        </p>
      )}
      {year === null ? (
        <p className="muted mt-4">Loading…</p>
      ) : (
        <div className="mt-4">
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
        </div>
      )}
    </section>
  )
}
