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

/**
 * Caelan lent-and-was-repaid in CAD and is still owed 480, while 550 of raw
 * flow crossed between them. The two numbers deliberately differ: the balance
 * is the debt, the net is movement.
 */
const MOCK_LEDGER = {
  contactId: 1,
  name: 'Caelan',
  loanDefault: false,
  transferNet: [{ currency: 'CAD', sent: '550.0000', received: '70.0000', net: '480.0000' }],
  loanBalance: [{ currency: 'CAD', lent: '500.0000', repaid: '20.0000', balance: '480.0000' }],
  trackedOutstandingByCurrency: { CAD: '200.0000' },
  transfers: [
    {
      id: 10,
      date: '2020-01-01',
      amount: '-200.0000',
      currency: 'CAD',
      merchant: 'Transfer',
      direction: 'out',
      isLoan: false,
      counterpartyRole: null,
      ledgerEffect: 'none',
      roleMismatch: false,
      cancelled: false,
    },
  ],
};

beforeEach(() => {
  vi.spyOn(api, 'getJson').mockResolvedValue([MOCK_CONTACT] as never);
  vi.spyOn(api, 'getContactLedger').mockResolvedValue(MOCK_LEDGER as never);
  vi.spyOn(api, 'getSelfSuggestions').mockResolvedValue({ suggestions: [] } as never);
  vi.spyOn(api, 'setContactSelf').mockResolvedValue({} as never);
});

describe('PeopleLedgerPage — landing list', () => {
  it('leads with the loan balance, and labels raw flow without a debt claim', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    // Contact name in list
    expect(await screen.findByText('Caelan')).toBeInTheDocument();

    const contactRow = await screen.findByTestId('contact-row-1');

    // The balance is the only cell allowed to say "owed"
    const balanceCell = within(contactRow).getByTestId('balance-1');
    expect(within(balanceCell).getByText('CAD 480.00 owed to you')).toBeInTheDocument();

    // Raw flow is described, never claimed
    const netCell = within(contactRow).getByTestId('net-1');
    expect(within(netCell).getByText('CAD 480.00 net out')).toBeInTheDocument();
    expect(netCell.textContent).not.toMatch(/owed|you owe/i);
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

  it('shows one balance metric per currency instead of dropping all but the first', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      loanBalance: [
        { currency: 'CAD', lent: '500.0000', repaid: '20.0000', balance: '480.0000' },
        { currency: 'USD', lent: '0.0000', repaid: '3570.5100', balance: '-3570.5100' },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metrics = await screen.findByTestId('loan-balance-metrics');
    expect(within(metrics).getByText('CAD 480.00 owed to you')).toBeInTheDocument();
    // The USD leg used to be silently discarded by the CAD-or-first pick.
    expect(within(metrics).getByText('USD 3570.51 you owe')).toBeInTheDocument();
  });

  it('does not net opposing debts across people into "settled"', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, name: 'Caelan', isSelf: false },
      { id: 2, name: 'Stephen', isSelf: false },
    ] as never);
    vi.spyOn(api, 'getContactLedger').mockImplementation((id: number) =>
      Promise.resolve({
        ...MOCK_LEDGER,
        contactId: id,
        loanBalance:
          id === 1
            ? [{ currency: 'CAD', lent: '480.0000', repaid: '0.0000', balance: '480.0000' }]
            : [{ currency: 'CAD', lent: '0.0000', repaid: '480.0000', balance: '-480.0000' }],
      }) as never,
    );

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metrics = await screen.findByTestId('loan-balance-metrics');
    // +480 and -480 must NOT cancel into "CAD 0.00 settled" — two live debts.
    expect(within(metrics).getByText('CAD 480.00 owed to you')).toBeInTheDocument();
    expect(within(metrics).getByText('CAD 480.00 you owe')).toBeInTheDocument();
    expect(metrics.textContent).not.toMatch(/settled/i);
  });

  it('says a balance could not be loaded rather than claiming there is none', async () => {
    vi.spyOn(api, 'getContactLedger').mockRejectedValue(new Error('boom') as never);

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const contactRow = await screen.findByTestId('contact-row-1');
    const balanceCell = within(contactRow).getByTestId('balance-1');
    // An unknown balance is not a zero balance.
    expect(balanceCell).toHaveTextContent("Couldn't load");
    expect(balanceCell).not.toHaveTextContent('No tracked loans');
  });

  it('does not claim nothing is outstanding when every balance failed to load', async () => {
    vi.spyOn(api, 'getContactLedger').mockRejectedValue(new Error('boom') as never);

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metricsCard = await screen.findByTestId('metrics-card');
    // Zero loaded balances is not zero debt. The headline may not assert one.
    expect(metricsCard.textContent).not.toMatch(/nothing outstanding/i);
    const metrics = within(metricsCard).getByTestId('loan-balance-metrics');
    expect(metrics).toHaveTextContent(/couldn't load/i);
    // …and with nothing loaded there is no total to show at all.
    expect(metrics.textContent).not.toMatch(/owed to you|you owe|settled/i);
    expect(
      within(metricsCard).getByTestId('metrics-incomplete').textContent,
    ).toMatch(/1 contact/i);

    // "Tracked loans" is derived from the same ledgers, so a bare 0 there
    // would read as "none tracked" over a set nobody could load.
    const trackedLabel = within(metricsCard).getByText('Tracked loans');
    const trackedTile = trackedLabel.closest('div[class*="flex-col"]');
    expect(trackedTile).not.toBeNull();
    expect(within(trackedTile as HTMLElement).queryByText('0')).toBeNull();
  });

  it('marks the headline total incomplete when only some balances failed', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, name: 'Caelan', isSelf: false },
      { id: 2, name: 'Stephen', isSelf: false },
    ] as never);
    vi.spyOn(api, 'getContactLedger').mockImplementation((id: number) =>
      id === 1
        ? (Promise.resolve(MOCK_LEDGER) as never)
        : (Promise.reject(new Error('boom')) as never),
    );

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metricsCard = await screen.findByTestId('metrics-card');
    const metrics = within(metricsCard).getByTestId('loan-balance-metrics');
    // The balance that did load is still shown…
    expect(within(metrics).getByText('CAD 480.00 owed to you')).toBeInTheDocument();
    // …but the page says the total is partial, and by how much.
    const marker = within(metricsCard).getByTestId('metrics-incomplete');
    expect(marker.textContent).toMatch(/incomplete/i);
    expect(marker.textContent).toMatch(/1 contact/i);
  });

  it('says incomplete rather than "nothing outstanding" when the loaded ledgers carry no debt', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, name: 'Caelan', isSelf: false },
      { id: 2, name: 'Stephen', isSelf: false },
    ] as never);
    vi.spyOn(api, 'getContactLedger').mockImplementation((id: number) =>
      id === 1
        ? (Promise.resolve({ ...MOCK_LEDGER, loanBalance: [] }) as never)
        : (Promise.reject(new Error('boom')) as never),
    );

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metricsCard = await screen.findByTestId('metrics-card');
    // One contact loaded clean, one is unknown — "nothing outstanding" would
    // be a zero-debt assertion over a balance nobody has seen.
    expect(metricsCard.textContent).not.toMatch(/nothing outstanding/i);
    expect(within(metricsCard).getByTestId('metrics-incomplete')).toBeInTheDocument();
  });

  it('still says nothing is outstanding when every ledger loaded clean', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      loanBalance: [],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metricsCard = await screen.findByTestId('metrics-card');
    expect(metricsCard).toHaveTextContent(/nothing outstanding/i);
    expect(within(metricsCard).queryByTestId('metrics-incomplete')).toBeNull();
  });

  it('captions the tracked-loans column so it is not read as the balance', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('contact-row-1');
    const caption = screen.getByTestId('outstanding-loans-caption');
    expect(caption.textContent).toMatch(/reimbursement/i);
    expect(caption.textContent).toMatch(/not the (loan )?balance/i);
  });

  it('makes no owed or owe claim for a contact with no loan balance', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      loanBalance: [],
      transferNet: [{ currency: 'CAD', sent: '117506.17', received: '73871.32', net: '43634.85' }],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const contactRow = await screen.findByTestId('contact-row-1');
    expect(within(contactRow).getByText('CAD 43634.85 net out')).toBeInTheDocument();
    // 43k of raw flow, zero debt: nothing on this row may say "owed" or "owe".
    expect(contactRow.textContent).not.toMatch(/owed|you owe/i);

    const metrics = await screen.findByTestId('loan-balance-metrics');
    expect(metrics.textContent).not.toMatch(/owed|you owe/i);
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
  it('shows the balance, the raw flow, and the tracked balance for a selected contact', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );
    const summaryCard = await screen.findByTestId('ledger-summary-card');
    // The debt
    const balanceSection = within(summaryCard).getByTestId('loan-balance');
    expect(within(balanceSection).getByText('CAD 480.00 owed to you')).toBeInTheDocument();
    // The movement — described, not claimed
    const netSection = within(summaryCard).getByTestId('raw-net-flow');
    expect(within(netSection).getByText('CAD 480.00 net out')).toBeInTheDocument();
    expect(netSection.textContent).not.toMatch(/owed|you owe/i);
    // Tracked outstanding — scoped to its container to avoid collision with transfer row
    const outstandingSection = await screen.findByTestId('tracked-outstanding');
    expect(within(outstandingSection).getByText(/200\.00/)).toBeInTheDocument();
    // Transfer row amount — scoped to the transfers table
    const transfersTable = await screen.findByTestId('transfers-table');
    expect(within(transfersTable).getByText('CAD -200.00')).toBeInTheDocument();
    // Mark as loan button
    expect(await screen.findByRole('button', { name: /mark as loan/i })).toBeInTheDocument();
  });

  it('tags a transfer via the role select and refetches the ledger', async () => {
    const setRoleSpy = vi.spyOn(api, 'setCounterpartyRole').mockResolvedValue({} as never);
    const getLedgerSpy = vi.spyOn(api, 'getContactLedger').mockResolvedValue(MOCK_LEDGER as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const select = await screen.findByTestId('role-select-10');
    const callsBefore = getLedgerSpy.mock.calls.length;
    await userEvent.selectOptions(select, 'loan');

    await waitFor(() => {
      expect(setRoleSpy).toHaveBeenCalledWith(10, 'loan');
    });
    // PATCH /api/transactions/:id does not echo counterpartyRole back, so the
    // page must refetch rather than trust the write.
    await waitFor(() => {
      expect(getLedgerSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('clears a tag back to the contact default with the auto option', async () => {
    const setRoleSpy = vi.spyOn(api, 'setCounterpartyRole').mockResolvedValue({} as never);
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      transfers: [{ ...MOCK_LEDGER.transfers[0], counterpartyRole: 'loan', ledgerEffect: 'loan' }],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const select = await screen.findByTestId('role-select-10');
    expect(select).toHaveValue('loan');
    await userEvent.selectOptions(select, '');

    await waitFor(() => {
      expect(setRoleSpy).toHaveBeenCalledWith(10, null);
    });
  });

  it('strikes through a cancelled e-transfer leg and says why', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      transfers: [{ ...MOCK_LEDGER.transfers[0], cancelled: true }],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('transfer-row-10');
    expect(row.className).toMatch(/line-through/);
    expect(row).toHaveAttribute('title', 'cancelled e-transfer pair');
  });

  it('warns when a tag disagrees with the direction', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      transfers: [
        { ...MOCK_LEDGER.transfers[0], counterpartyRole: 'repayment', ledgerEffect: 'loan', roleMismatch: true },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('role-mismatch-10')).toHaveTextContent(
      'tag disagrees with direction',
    );
    expect(await screen.findByTestId('mismatch-summary')).toHaveTextContent(
      '1 transfer is tagged against its direction',
    );
  });

  it('toggles the contact loanDefault', async () => {
    const setDefaultSpy = vi.spyOn(api, 'setContactLoanDefault').mockResolvedValue({} as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const toggle = await screen.findByTestId('loan-default-toggle');
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(setDefaultSpy).toHaveBeenCalledWith(1, true);
    });
  });

  it('distinguishes the tracked-loans tile from the loan balance', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    // CAD 480.00 and CAD 200.00 sit side by side and mean different things.
    const outstanding = await screen.findByTestId('tracked-outstanding');
    const caption = within(outstanding).getByTestId('tracked-outstanding-caption');
    expect(caption.textContent).toMatch(/reimbursement/i);
    // It must point at the loan balance as the page's answer.
    expect(caption.textContent).toMatch(/loan balance/i);

    const balance = await screen.findByTestId('loan-balance');
    expect(
      within(balance).getByTestId('loan-balance-caption').textContent,
    ).toMatch(/what they owe you|this page's answer/i);
  });

  it('omits the lent-vs-repaid heading when there is no bar to draw', async () => {
    // Stephen's real USD row: nothing lent, 3570.51 repaid. computeBarSegments
    // draws nothing for it, so the heading must not stand alone over a void.
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      loanBalance: [{ currency: 'USD', lent: '0.0000', repaid: '3570.5100', balance: '-3570.5100' }],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const summaryCard = await screen.findByTestId('ledger-summary-card');
    expect(within(summaryCard).getByText('USD 3570.51 you owe')).toBeInTheDocument();
    expect(within(summaryCard).queryByText('Lent vs repaid')).toBeNull();
  });

  it('keeps the lent-vs-repaid heading when there is a bar to draw', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const summaryCard = await screen.findByTestId('ledger-summary-card');
    expect(within(summaryCard).getByText('Lent vs repaid')).toBeInTheDocument();
  });

  it('does not stick on "Loading…" when a reload supersedes the navigation fetch', async () => {
    // The navigation fetch is left in flight; `reload` (fired by "Link
    // transfers") bumps the request token, so the navigation fetch's
    // `isCurrent()` guard skips its own cleanup. Someone still has to clear
    // `ledgerLoading`, or the drill-in renders "Loading…" until navigation.
    let releaseNavFetch: (l: unknown) => void = () => {};
    const navFetch = new Promise((resolve) => { releaseNavFetch = resolve; });
    const getLedgerSpy = vi
      .spyOn(api, 'getContactLedger')
      .mockReturnValueOnce(navFetch as never)
      .mockResolvedValue(MOCK_LEDGER as never);
    vi.spyOn(api, 'commitTransferLink').mockResolvedValue({
      linked: 0,
      ambiguous: [],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    // The action bar renders outside the loading gate, so this is reachable.
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /link transfers/i }));

    await waitFor(() => {
      expect(getLedgerSpy.mock.calls.length).toBeGreaterThan(1);
    });
    // The reload's ledger is on screen; the stale in-flight fetch must not
    // leave the page pinned to the loading state.
    expect(await screen.findByTestId('ledger-summary-card')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();

    releaseNavFetch(MOCK_LEDGER);
  });

  it('shows raw bank text in the merchant column', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      transfers: [{ ...MOCK_LEDGER.transfers[0], merchant: 'e-Transfer sent Caelan' }],
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const transfersTable = await screen.findByTestId('transfers-table');
    expect(within(transfersTable).getByText('e-Transfer sent Caelan')).toBeInTheDocument();
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
