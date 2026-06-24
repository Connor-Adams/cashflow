import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PartnerHomePage } from './PartnerHomePage'
import * as api from '../lib/api'

describe('PartnerHomePage', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('shows the is_partner contact balance, not a conflated total', async () => {
    vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
      if (url.startsWith('/api/partner/fairness')) {
        return {
          contacts: [
            { contactId: 7, contactName: 'Alex', isPartner: true, paybacks: [],
              byCurrency: [{ currency: 'CAD', balance: 10386.58, direction: 'partner_owes_me',
                currentMonthSharedSpend: 0, sharedTransactionCount: 3 }] },
            { contactId: 3, contactName: 'Dad', isPartner: false, paybacks: [],
              byCurrency: [{ currency: 'CAD', balance: -10557.74, direction: 'i_owe_partner',
                currentMonthSharedSpend: 0, sharedTransactionCount: 1 }] },
          ], excludeNonPartnerInflows: false,
        } as never
      }
      return [{ visibility: 'shared' }] as never
    })
    render(<MemoryRouter><PartnerHomePage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Alex')).toBeInTheDocument())
    expect(screen.queryByText('Dad')).not.toBeInTheDocument()
  })
})
