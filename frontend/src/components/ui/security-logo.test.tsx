import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SecurityLogo } from './security-logo'
import { _resetAppConfigForTest } from '../../lib/appConfig'

describe('SecurityLogo', () => {
  beforeEach(() => {
    _resetAppConfigForTest()
  })

  it('renders img with logo.dev URL when token configured', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(<SecurityLogo symbol="XEQT.TO" />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toContain('img.logo.dev/ticker/XEQT')
    expect(img?.getAttribute('src')).toContain('token=pk_test')
  })

  it('renders LetterAvatar when no token', () => {
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: false }
    const { container, queryByRole } = render(<SecurityLogo symbol="BNS" />)
    expect(container.querySelector('img')).toBeNull()
    expect(queryByRole('img')).not.toBeNull()
  })

  it('falls back to LetterAvatar on img error', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(<SecurityLogo symbol="WAT" />)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).not.toBeNull()
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('W')
  })
})
