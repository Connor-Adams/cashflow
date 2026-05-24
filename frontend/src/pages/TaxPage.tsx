import { useState } from 'react'
import { Tabs } from '../components/ui/tabs'

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'personal', label: 'Personal T1' },
  { value: 'slips', label: 'Slips' },
]

function PlaceholderTab({ name }: { name: string }) {
  return <p className="muted">{name} tab — coming in Task 21.</p>
}

export function TaxPage() {
  const [tab, setTab] = useState('overview')
  return (
    <section>
      <header>
        <h1>Tax</h1>
      </header>
      <Tabs items={TABS} value={tab} onValueChange={setTab} />
      {tab === 'overview' && <PlaceholderTab name="Overview" />}
      {tab === 'personal' && <PlaceholderTab name="Personal T1" />}
      {tab === 'slips' && <PlaceholderTab name="Slips" />}
    </section>
  )
}
