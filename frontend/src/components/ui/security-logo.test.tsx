import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SecurityLogo } from './security-logo'
import { _resetAppConfigForTest } from '../../lib/appConfig'

describe('SecurityLogo', () => {
  beforeEach(() => {
    _resetAppConfigForTest()
  })

  it('renders /ticker URL with exchange suffix preserved when present', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(<SecurityLogo symbol="XEQT.TO" />)
    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(src).toContain('img.logo.dev/ticker/XEQT.TO')
    expect(src).toContain('token=pk_test')
  })

  it('infers .TO suffix for CAD-denominated tickers without a suffix', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(<SecurityLogo symbol="TD" currency="CAD" />)
    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(src).toContain('img.logo.dev/ticker/TD.TO')
  })

  it('leaves USD tickers without a suffix unchanged', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(<SecurityLogo symbol="NVDA" currency="USD" />)
    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(src).toContain('img.logo.dev/ticker/NVDA')
    expect(src).not.toContain('NVDA.TO')
  })

  it('routes crypto holdings to /crypto endpoint', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(
      <SecurityLogo symbol="ETH" assetType="cryptocurrency" />,
    )
    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(src).toContain('img.logo.dev/crypto/ETH')
  })

  it('routes ETFs to the issuer domain when prefix matches', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(
      <SecurityLogo symbol="XEQT" assetType="etf" currency="CAD" />,
    )
    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(src).toContain('img.logo.dev/ishares.com')
  })

  it('routes Vanguard ETFs (V-prefix) to vanguard.com', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(
      <SecurityLogo symbol="VFV" assetType="etf" currency="CAD" />,
    )
    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(src).toContain('img.logo.dev/vanguard.com')
  })

  it('does NOT route V-prefix stocks (e.g. Visa) to vanguard.com', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(
      <SecurityLogo symbol="V" assetType="stock" currency="USD" />,
    )
    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(src).toContain('img.logo.dev/ticker/V')
    expect(src).not.toContain('vanguard.com')
  })

  it('falls through to /ticker for ETFs with no issuer match', () => {
    window.__APP_CONFIG__ = { logoDevToken: 'pk_test', quoteProviderConfigured: true }
    const { container } = render(
      <SecurityLogo symbol="QQQ" assetType="etf" currency="USD" />,
    )
    const src = container.querySelector('img')?.getAttribute('src') ?? ''
    expect(src).toContain('img.logo.dev/ticker/QQQ')
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
