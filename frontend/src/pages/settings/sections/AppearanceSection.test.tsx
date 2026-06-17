// frontend/src/pages/settings/sections/AppearanceSection.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AppearanceSection } from './AppearanceSection'

vi.mock('./PaletteSection', () => ({ PaletteSection: () => <div>palette-marker</div> }))
vi.mock('./DesignSystemSection', () => ({ DesignSystemSection: () => <div>design-system-marker</div> }))

describe('AppearanceSection', () => {
  it('renders both the palette and design-system sections', () => {
    render(<AppearanceSection />)
    expect(screen.getByText('palette-marker')).toBeInTheDocument()
    expect(screen.getByText('design-system-marker')).toBeInTheDocument()
  })
})
