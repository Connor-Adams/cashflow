import { useState } from 'react'
import { Tabs } from '../components/ui/tabs'
import { OverviewTab } from './tax/OverviewTab'
import { PersonalT1Tab } from './tax/PersonalT1Tab'
import { SlipsTab } from './tax/SlipsTab'

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'personal', label: 'Personal T1' },
  { value: 'slips', label: 'Slips' },
]

export function TaxPage() {
  const [tab, setTab] = useState('overview')
  return (
    <section>
      <header>
        <h1>Tax</h1>
      </header>
      <Tabs items={TABS} value={tab} onValueChange={setTab} />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'personal' && <PersonalT1Tab />}
      {tab === 'slips' && <SlipsTab />}
    </section>
  )
}
