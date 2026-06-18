import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TxnMerchantCell, TxnMerchantName, TxnMerchantMeta } from './txn-merchant-cell'

describe('TxnMerchantCell', () => {
  it('renders name and meta', () => {
    const { getByText } = render(
      <TxnMerchantCell>
        <TxnMerchantName>Acme Corp</TxnMerchantName>
        <TxnMerchantMeta>Checking · 2024-01</TxnMerchantMeta>
      </TxnMerchantCell>
    )
    expect(getByText('Acme Corp')).not.toBeNull()
    expect(getByText('Checking · 2024-01')).not.toBeNull()
  })

  it('renders arbitrary extra children alongside name', () => {
    const { getByText } = render(
      <TxnMerchantCell>
        <TxnMerchantName>Shop</TxnMerchantName>
        <span>Rule #42</span>
        <button>Why?</button>
      </TxnMerchantCell>
    )
    expect(getByText('Shop')).not.toBeNull()
    expect(getByText('Rule #42')).not.toBeNull()
    expect(getByText('Why?')).not.toBeNull()
  })

  it('applies data-slot attributes', () => {
    const { container } = render(
      <TxnMerchantCell>
        <TxnMerchantName>N</TxnMerchantName>
        <TxnMerchantMeta>M</TxnMerchantMeta>
      </TxnMerchantCell>
    )
    expect(container.querySelector('[data-slot="txn-merchant-cell"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="txn-merchant-name"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="txn-merchant-meta"]')).not.toBeNull()
  })

  it('merges className', () => {
    const { container } = render(
      <TxnMerchantCell className="custom-class">
        <TxnMerchantName>N</TxnMerchantName>
      </TxnMerchantCell>
    )
    expect(container.firstElementChild?.className).toContain('custom-class')
  })
})
