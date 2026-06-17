import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DesignSystemSection } from './DesignSystemSection'

describe('DesignSystemSection', () => {
  it('renders a section heading for each primitive group', () => {
    render(<DesignSystemSection />)
    for (const group of ['Buttons', 'Cards & stats', 'Badges', 'Alerts', 'Inputs', 'States']) {
      expect(screen.getByRole('heading', { name: group })).toBeInTheDocument()
    }
  })

  it('renders every button variant', () => {
    render(<DesignSystemSection />)
    for (const v of ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link']) {
      expect(screen.getByRole('button', { name: v })).toBeInTheDocument()
    }
  })
})
