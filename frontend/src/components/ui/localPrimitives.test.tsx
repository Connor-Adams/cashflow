import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './empty-state'
import { Label } from './label'
import { NativeSelect, NativeSelectOption } from './native-select'
import { PageHeader } from './page-header'
import { StatCard } from './stat-card'

describe('local design-system primitives', () => {
  it('renders labeled native selects with compact sizing', () => {
    const html = renderToStaticMarkup(
      <Label>
        Status
        <NativeSelect size="sm" defaultValue="open">
          <NativeSelectOption value="open">Open</NativeSelectOption>
          <NativeSelectOption value="closed">Closed</NativeSelectOption>
        </NativeSelect>
      </Label>
    )

    expect(html).toContain('data-slot="label"')
    expect(html).toContain('data-slot="native-select"')
    expect(html).toContain('Open')
  })

  it('renders page headers with title, description, and actions', () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="Review Inbox"
        description="Clear imported transactions."
        actions={<button type="button">Refresh</button>}
      />
    )

    expect(html).toContain('<h1')
    expect(html).toContain('Review Inbox')
    expect(html).toContain('Clear imported transactions.')
    expect(html).toContain('Refresh')
  })

  it('renders stat and empty-state primitives', () => {
    const html = renderToStaticMarkup(
      <>
        <StatCard label="Unreviewed" value="6" hint="Open transactions" />
        <EmptyState title="No rows" description="Everything is reviewed." />
      </>
    )

    expect(html).toContain('Unreviewed')
    expect(html).toContain('Open transactions')
    expect(html).toContain('No rows')
    expect(html).toContain('Everything is reviewed.')
  })
})
