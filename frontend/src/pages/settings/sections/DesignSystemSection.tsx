import React from 'react'
import { Card } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Badge } from '@connor-adams/designsystem'
import { Alert } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { Label } from '@connor-adams/designsystem'
import { StatCard } from '@/components/ui/stat-card'
import { EmptyState } from '@connor-adams/designsystem'
import { SectionHeader } from '@/components/ui/section-header'
import { Grid } from '@/lib/ds-extras'
import { FilterCard } from '@/components/ui/filter-card'
import { TableCard } from '@/components/ui/table-card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'
import { Skeleton, SkeletonText } from '@connor-adams/designsystem'
import { SkeletonRow } from '@/lib/ds-extras'

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
        <Badge variant="count">Count</Badge>
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

      <Group name="Skeletons (loading)">
        <div className="w-full space-y-2 sm:w-56">
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
        <div className="w-full sm:w-56">
          <SkeletonText lines={4} />
        </div>
        <div className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 3 }).map((_, i) => (
                <SkeletonRow key={`ds-skeleton-${i}`} cols={3} />
              ))}
            </TableBody>
          </Table>
        </div>
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

      <Group name="Table card">
        <TableCard title="Example" actions={<Badge variant="count">3</Badge>} className="w-full">
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>RRSP</TableCell>
              <TableCell>$42,100</TableCell>
              <TableCell>+2.1%</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>TFSA</TableCell>
              <TableCell>$18,400</TableCell>
              <TableCell>-0.5%</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Taxable</TableCell>
              <TableCell>$9,800</TableCell>
              <TableCell>+1.3%</TableCell>
            </TableRow>
          </TableBody>
        </TableCard>
      </Group>

      <Group name="Sortable table card">
        <TableCard
          title="Holdings"
          description="Click a header to sort: ascending → descending → default."
          actions={<Badge variant="count">3</Badge>}
          className="w-full"
          columns={[
            { key: 'account', header: 'Account', sortable: true },
            { key: 'value', header: 'Value', sortable: true, align: 'right', render: (r) => `$${r.value.toLocaleString()}` },
            { key: 'change', header: 'Change', sortable: true, align: 'right', render: (r) => `${r.change > 0 ? '+' : ''}${r.change}%` },
          ]}
          rows={[
            { account: 'RRSP', value: 42100, change: 2.1 },
            { account: 'TFSA', value: 18400, change: -0.5 },
            { account: 'Taxable', value: 9800, change: 1.3 },
          ]}
          defaultSort={{ key: 'value', dir: 'desc' }}
          getRowKey={(r) => r.account}
        />
      </Group>
    </Card>
  )
}
