import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TaxWarningsStrip } from './TaxWarningsStrip'

describe('TaxWarningsStrip', () => {
  it('returns null when warnings is empty', () => {
    const { container } = render(<TaxWarningsStrip warnings={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one row per warning with text', () => {
    const { getByText } = render(
      <TaxWarningsStrip
        warnings={[
          { kind: 'fixed_income_in_non_reg', securityId: 1, symbol: 'BND', accountName: 'NR', text: 'Bond in NR' },
          { kind: 'us_payer_in_tfsa', securityId: 2, symbol: 'VOO', accountName: 'TFSA01', text: 'US payer in TFSA' },
        ]}
      />,
    )
    expect(getByText('Bond in NR')).not.toBeNull()
    expect(getByText('US payer in TFSA')).not.toBeNull()
  })
})
