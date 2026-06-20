import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SeverityBadge } from './SeverityBadge'

describe('SeverityBadge', () => {
  it('renders action severity with destructive variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="action" />)
    expect(html).toContain('action')
    // DS Badge renders the variant via data-variant, not a class name.
    expect(html).toContain('data-variant="destructive"')
  })

  it('renders watch severity with secondary variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="watch" />)
    expect(html).toContain('watch')
    expect(html).toContain('data-variant="secondary"')
  })

  it('renders info severity with outline variant', () => {
    const html = renderToStaticMarkup(<SeverityBadge severity="info" />)
    expect(html).toContain('info')
    expect(html).toContain('data-variant="outline"')
  })
})
