// frontend/src/pages/PeopleLedgerPage.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PeopleLedgerPage } from './PeopleLedgerPage';
import * as api from '../lib/api';

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof api>()), }));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));

beforeEach(() => {
  vi.spyOn(api, 'getJson').mockResolvedValue([{ id: 1, name: 'Caelan' }] as never);
  vi.spyOn(api, 'getContactLedger').mockResolvedValue({
    contactId: 1, name: 'Caelan',
    transferNet: [{ currency: 'CAD', sent: '550.0000', received: '70.0000', net: '480.0000' }],
    trackedOutstandingByCurrency: { CAD: '200.0000' },
    transfers: [{ id: 10, date: '2020-01-01', amount: '-200.0000', currency: 'CAD', merchant: 'Transfer', direction: 'out', isLoan: false }],
  } as never);
});

describe('PeopleLedgerPage', () => {
  it('shows raw net and tracked balance for a selected contact', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/CAD 480.00 owed to you/)).toBeInTheDocument();
    expect(await screen.findByText(/200\.00/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /mark as loan/i })).toBeInTheDocument();
  });
});
