import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SanitizedHtml } from './SanitizedHtml'

void React

describe('SanitizedHtml', () => {
  it('injects the provided html', () => {
    render(<SanitizedHtml html="<p>Hello <strong>world</strong></p>" />)
    expect(screen.getByText('world')).toBeInTheDocument()
  })
})
