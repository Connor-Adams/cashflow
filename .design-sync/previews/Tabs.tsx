import { useState } from 'react'
import { Tabs, TabPanel } from '@cashflow/ui'

const items = [
  { value: 'overview', label: 'Overview' },
  { value: 'transactions', label: 'Transactions' },
  { value: 'budgets', label: 'Budgets' },
]

export function AccountTabs() {
  const [tab, setTab] = useState('overview')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 420 }}>
      <Tabs items={items} value={tab} onValueChange={setTab} id="acct" />
      <TabPanel value="overview" active={tab} tabsId="acct">
        <p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 14 }}>
          Net worth $48,210 · up 2.1% this month.
        </p>
      </TabPanel>
      <TabPanel value="transactions" active={tab} tabsId="acct">
        <p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 14 }}>
          1,284 transactions across 6 accounts.
        </p>
      </TabPanel>
      <TabPanel value="budgets" active={tab} tabsId="acct">
        <p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 14 }}>
          3 of 8 budgets over limit this period.
        </p>
      </TabPanel>
    </div>
  )
}
