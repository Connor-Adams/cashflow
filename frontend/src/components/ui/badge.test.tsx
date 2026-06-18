import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Badge } from './badge'

describe('Badge', () => {
  it('default variant renders the brand chip', () => {
    const { container } = render(<Badge>New</Badge>)
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement
    expect(el.className).toContain('bg-brand')
  })
  it('count variant is an uppercase bold compact chip', () => {
    const { container } = render(<Badge variant="count">5 rules</Badge>)
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement
    expect(el.className).toContain('uppercase')
    expect(el.className).toContain('font-bold')
    expect(el.className).toContain('text-[0.68rem]')
    expect(el.className).not.toContain('text-xs') // twMerge dropped the base size
  })
})
