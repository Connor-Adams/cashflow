// frontend/src/pages/PeopleLedgerPage.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PeopleLedgerPage } from './PeopleLedgerPage';
import * as api from '../lib/api';

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof api>()), }));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));

const MOCK_CONTACT = { id: 1, name: 'Caelan', isSelf: false };
const MOCK_LEDGER = {
  contactId: 1,
  name: 'Caelan',
  transferNet: [{ currency: 'CAD', sent: '550.0000', received: '70.0000', net: '480.0000' }],
  trackedOutstandingByCurrency: { CAD: '200.0000' },
  transfers: [
    { id: 10, date: '2020-01-01', amount: '-200.0000', currency: 'CAD', merchant: 'Transfer', direction: 'out', isLoan: false },
  ],
};

beforeEach(() => {
  vi.spyOn(api, 'getJson').mockResolvedValue([MOCK_CONTACT] as never);
  vi.spyOn(api, 'getContactLedger').mockResolvedValue(MOCK_LEDGER as never);
  vi.spyOn(api, 'getSelfSuggestions').mockResolvedValue({ suggestions: [] } as never);
  vi.spyOn(api, 'setContactSelf').mockResolvedValue({} as never);
});

describe('PeopleLedgerPage — landing list', () => {
  it('shows net owed for a contact on the landing list', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    // Contact name in list
    expect(await screen.findByText('Caelan')).toBeInTheDocument();

    // Net owed label — scoped to the contact row to avoid collision
    const contactRow = await screen.findByTestId('contact-row-1');
    const netCell = within(contactRow).getByTestId('net-1');
    expect(within(netCell).getByText(/480\.00 owed to you/)).toBeInTheDocument();
  });

  it('shows metrics card with people count', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metricsCard = await screen.findByTestId('metrics-card');
    // Find the "People" label element, then check its sibling value
    const peopleLabel = within(metricsCard).getByText('People');
    expect(peopleLabel).toBeInTheDocument();
    // The value is in a sibling div inside the same flex container
    const peopleCard = peopleLabel.closest('div[class*="flex-col"]');
    expect(peopleCard).not.toBeNull();
    expect(within(peopleCard as HTMLElement).getByText('1')).toBeInTheDocument();
  });
});

describe('PeopleLedgerPage — self-account suggestions', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getSelfSuggestions').mockResolvedValue({
      suggestions: [{ id: 99, name: 'Connor RBC', reason: 'matches your name: connor' }],
    } as never);
  });

  it('shows self-suggestion with reason and exclude button', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    // Section heading
    expect(await screen.findByText(/these look like your own accounts/i)).toBeInTheDocument();

    // Suggestion name
    const section = await screen.findByTestId('self-account-section');
    expect(within(section).getByText('Connor RBC')).toBeInTheDocument();

    // Reason
    const reasonEl = within(section).getByTestId('self-reason-99');
    expect(reasonEl).toHaveTextContent('matches your name: connor');

    // Exclude button
    const excludeBtn = within(section).getByTestId('exclude-btn-99');
    expect(excludeBtn).toBeInTheDocument();
    expect(excludeBtn).toHaveTextContent(/not a person/i);
  });

  it('calls setContactSelf when exclude button is clicked', async () => {
    const setContactSelfSpy = vi.spyOn(api, 'setContactSelf').mockResolvedValue({} as never);
    // After exclusion, reload returns no more suggestions
    vi.spyOn(api, 'getSelfSuggestions')
      .mockResolvedValueOnce({ suggestions: [{ id: 99, name: 'Connor RBC', reason: 'matches your name: connor' }] } as never)
      .mockResolvedValue({ suggestions: [] } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const excludeBtn = await screen.findByTestId('exclude-btn-99');
    await userEvent.click(excludeBtn);

    await waitFor(() => {
      expect(setContactSelfSpy).toHaveBeenCalledWith(99, true);
    });
  });
});

describe('PeopleLedgerPage — drill-in', () => {
  it('shows raw net and tracked balance for a selected contact', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );
    // Raw-net label — scoped to the summary card
    const summaryCard = await screen.findByTestId('ledger-summary-card');
    expect(within(summaryCard).getByText(/CAD 480.00 owed to you/)).toBeInTheDocument();
    // Tracked outstanding — scoped to its container to avoid collision with transfer row
    const outstandingSection = await screen.findByTestId('tracked-outstanding');
    expect(within(outstandingSection).getByText(/200\.00/)).toBeInTheDocument();
    // Transfer row amount — scoped to the transfers table
    const transfersTable = await screen.findByTestId('transfers-table');
    expect(within(transfersTable).getByText('CAD -200.00')).toBeInTheDocument();
    // Mark as loan button
    expect(await screen.findByRole('button', { name: /mark as loan/i })).toBeInTheDocument();
  });
});

describe('PeopleLedgerPage — partner exclusion', () => {
  it('does not list a partner contact but does list a normal contact', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, name: 'Caelan', isSelf: false },
      { id: 2, name: 'Fairness Partner', isSelf: false, isPartner: true },
    ] as never);

    const { queryByText } = render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    // Normal contact should appear
    expect(await screen.findByText('Caelan')).toBeInTheDocument();
    // Partner contact must NOT appear
    expect(queryByText('Fairness Partner')).toBeNull();
  });
});
