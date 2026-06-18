import React from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatCard } from '@/components/ui/stat-card'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionHeader } from '@/components/ui/section-header'
import { Grid } from '@/components/ui/grid'
import { FilterCard } from '@/components/ui/filter-card'

const BUTTON_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const
const ALERT_VARIANTS = ['error', 'warning', 'info', 'success'] as const

function Group({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">{name}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  )
}

export function DesignSystemSection() {
  return (
    <Card className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Design System</h1>
        <p className="text-sm text-muted-foreground">
          Live primitives in every variant and state. The implementation target for every page.
        </p>
      </div>

      <Group name="Buttons">
        {BUTTON_VARIANTS.map((v) => (
          <Button key={v} variant={v}>{v}</Button>
        ))}
      </Group>

      <Group name="Cards & stats">
        <StatCard label="Transactions" value="1,284" hint="This month" />
        <StatCard label="Net spend" value="$4,210" delta="+12%" metricKind="spend" />
      </Group>

      <Group name="Badges">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
      </Group>

      <Group name="Alerts">
        {ALERT_VARIANTS.map((v) => (
          <Alert key={v} variant={v} className="w-full sm:w-72">
            {v} alert message
          </Alert>
        ))}
      </Group>

      <Group name="Inputs">
        <div className="grid gap-1.5">
          <Label htmlFor="ds-input">Label</Label>
          <Input id="ds-input" placeholder="Placeholder" />
        </div>
      </Group>

      <Group name="States">
        <EmptyState
          className="w-full sm:w-80"
          title="Nothing here yet"
          description="The canonical empty state."
        />
      </Group>

      <Group name="Filter card">
        <FilterCard className="w-full">
          <div className="text-sm text-muted-foreground">Comfortable filter bar</div>
        </FilterCard>
        <FilterCard density="compact">
          <div className="text-sm text-muted-foreground">Compact</div>
        </FilterCard>
      </Group>

      <Group name="Section header">
        <SectionHeader
          className="w-full"
          title="Section title"
          description="Supporting description"
          actions={<Button variant="secondary">Action</Button>}
        />
      </Group>
      <Group name="Grid">
        <Grid minItemWidth={160} gap="md" className="w-full">
          <StatCard label="Revenue" value="$12,400" hint="This month" />
          <StatCard label="Expenses" value="$8,230" delta="-5%" metricKind="spend" />
          <StatCard label="Net" value="$4,170" delta="+8%" metricKind="gain" />
          <StatCard label="Savings rate" value="33%" hint="Of income" />
        </Grid>
      </Group>
    </Card>
  )
}
