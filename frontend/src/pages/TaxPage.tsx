import { useEffect, useState } from 'react'
import { Tabs } from '../components/ui/tabs'
import { OverviewTab } from './tax/OverviewTab'
import { PersonalT1Tab } from './tax/PersonalT1Tab'
import { SlipsTab } from './tax/SlipsTab'
import { useTaxYears } from '../hooks/useTaxYears'

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'personal', label: 'Personal T1' },
  { value: 'slips', label: 'Slips' },
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

  useEffect(() => {
    if (year === null && years && years.length > 0) {
      setYear(pickDefaultYear(years))
    }
  }, [years, year])

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
        <h1>Tax</h1>
        {years && year !== null && (
          <label>
            Year{' '}
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
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
          {tab === 'overview' && <OverviewTab year={year} />}
          {tab === 'personal' && <PersonalT1Tab year={year} />}
          {tab === 'slips' && <SlipsTab year={year} />}
        </>
      )}
    </section>
  )
}
