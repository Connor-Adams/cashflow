import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SeverityBadge } from './SeverityBadge'

describe('SeverityBadge', () => {
  it('renders action severity with destructive variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="action" />)
    expect(html).toContain('action')
    // Badge cva emits 'bg-destructive' for the destructive variant
    expect(html).toContain('bg-destructive')
  })

  it('renders watch severity with secondary variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="watch" />)
    expect(html).toContain('watch')
    // Badge cva emits 'bg-muted' for the secondary variant
    expect(html).toContain('bg-muted')
  })

  it('renders info severity with outline variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="info" />)
    expect(html).toContain('info')
    // Badge cva emits 'border-border' for the outline variant
    expect(html).toContain('border-border')
  })
})
