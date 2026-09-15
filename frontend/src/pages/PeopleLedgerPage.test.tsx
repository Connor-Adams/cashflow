// frontend/src/pages/PeopleLedgerPage.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PeopleLedgerPage } from './PeopleLedgerPage';
import * as api from '../lib/api';

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof api>()), }));

/**
 * One stable spy for the whole file. A fresh `vi.fn()` per `useToast()` call
 * would be unassertable — the page keeps its own ref to whichever function it
 * got, so the test could never see the same object it does.
 */
const showToastMock = vi.hoisted(() => vi.fn());

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ showToast: showToastMock, dismissToast: vi.fn() }),
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
  showToastMock.mockClear();
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
    expect(within(metrics).getByText('USD 3,570.51 you owe')).toBeInTheDocument();
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
    expect(within(contactRow).getByText('CAD 43,634.85 net out')).toBeInTheDocument();
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
    // The reimbursement-claim button, named so it cannot be read as the Role
    // dropdown's "Loan" option (they move different numbers).
    expect(await screen.findByTestId('log-claim-10')).toBeInTheDocument();
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
    expect(within(summaryCard).getByText('USD 3,570.51 you owe')).toBeInTheDocument();
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

describe('PeopleLedgerPage — drill-in captions and controls', () => {
  // ── I1: the caption must describe the balance actually on screen ──────────

  it('says untagged transfers are counted when the loanDefault toggle is on', async () => {
    // With `loanDefault` on, `resolveLedgerRole` folds every untagged row in by
    // direction — on the real Evan and Caelan data that is most of the balance.
    // The toggle sits directly above this caption, so a caption that still said
    // "tagged loan or repayment" would be false the moment it is flipped.
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      loanDefault: true,
    } as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const balance = await screen.findByTestId('loan-balance');
    const caption = within(balance).getByTestId('loan-balance-caption').textContent ?? '';
    expect(caption).toMatch(/untagged/i);
    // …and it must point at the control that made it true.
    expect(caption).toMatch(/toggle/i);
  });

  it('says untagged transfers are not counted when the toggle is off', async () => {
    // MOCK_LEDGER.loanDefault is false.
    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const balance = await screen.findByTestId('loan-balance');
    const caption = within(balance).getByTestId('loan-balance-caption').textContent ?? '';
    expect(caption).toMatch(/untagged transfers are not counted/i);
  });

  // ── I2: a landed write with a failed refetch must not look like nothing ────

  it('warns when the write lands but the refetch fails', async () => {
    vi.spyOn(api, 'setCounterpartyRole').mockResolvedValue({} as never);
    vi.spyOn(api, 'getContactLedger')
      .mockResolvedValueOnce(MOCK_LEDGER as never)
      .mockRejectedValue(new Error('network down'));

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const select = await screen.findByTestId('role-select-10');
    await userEvent.selectOptions(select, 'loan');

    // The PATCH succeeded, so no write toast fires. Without this one the page
    // silently renders the pre-write balance under "What they owe you".
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/couldn.t be refreshed/i),
        }),
      );
    });
  });

  it('warns when the loanDefault toggle saves but the refetch fails', async () => {
    vi.spyOn(api, 'setContactLoanDefault').mockResolvedValue({} as never);
    vi.spyOn(api, 'getContactLedger')
      .mockResolvedValueOnce(MOCK_LEDGER as never)
      .mockRejectedValue(new Error('network down'));

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByTestId('loan-default-toggle'));

    // The Switch visibly reverts here while the server holds the new value.
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/couldn.t be refreshed/i),
        }),
      );
    });
  });

  // ── I3: two controls called "loan" moved two different numbers ────────────

  it('names the reimbursement button apart from the Role dropdown', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const button = await screen.findByTestId('log-claim-10');
    // "Mark as loan" collided with the Role dropdown's "Loan" option while
    // moving a different tile.
    expect(button.textContent ?? '').not.toMatch(/mark as loan/i);
    expect(button.textContent ?? '').toMatch(/claim/i);
    // It must say which tile it actually moves.
    expect(button.getAttribute('title') ?? '').toMatch(/tracked loans outstanding/i);
    expect(button.getAttribute('title') ?? '').toMatch(/loan balance/i);
  });

  it('still posts the reimbursement endpoint under the new label', async () => {
    const markSpy = vi.spyOn(api, 'markTransactionAsLoan').mockResolvedValue({} as never);

    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByTestId('log-claim-10'));

    await waitFor(() => {
      expect(markSpy).toHaveBeenCalledWith(10, 1);
    });
  });
});

// ── M4: metric totals accumulate as integers, not floats ────────────────────

describe('PeopleLedgerPage — metric totals', () => {
  it('does not round sub-cent balances away into "Nothing outstanding"', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, name: 'Caelan', isSelf: false },
      { id: 2, name: 'Stephen', isSelf: false },
    ] as never);
    vi.spyOn(api, 'getContactLedger').mockImplementation((id: number) =>
      Promise.resolve({
        ...MOCK_LEDGER,
        contactId: id,
        loanBalance: [
          { currency: 'CAD', lent: '0.0002', repaid: '0.0000', balance: '0.0002' },
        ],
      } as never),
    );

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metrics = await screen.findByTestId('loan-balance-metrics');
    // Cents-rounding the accumulator zeroed these and the tile then claimed
    // nothing was outstanding over two live balances.
    await waitFor(() => {
      expect(metrics.textContent ?? '').not.toMatch(/nothing outstanding/i);
    });
    // Two contacts at 0.0002 each. Cents-rounding the accumulator collapsed
    // the total to 0, the tile vanished, and the debts are still real.
    expect(within(metrics).getByText('CAD 0.00 owed to you')).toBeInTheDocument();
  });

  it('sums many balances without float drift', async () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004.
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, name: 'Caelan', isSelf: false },
      { id: 2, name: 'Stephen', isSelf: false },
    ] as never);
    vi.spyOn(api, 'getContactLedger').mockImplementation((id: number) =>
      Promise.resolve({
        ...MOCK_LEDGER,
        contactId: id,
        loanBalance: [
          {
            currency: 'CAD',
            lent: id === 1 ? '0.1000' : '0.2000',
            repaid: '0.0000',
            balance: id === 1 ? '0.1000' : '0.2000',
          },
        ],
      } as never),
    );

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metrics = await screen.findByTestId('loan-balance-metrics');
    expect(await within(metrics).findByText('CAD 0.30 owed to you')).toBeInTheDocument();
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

// ── Line-of-credit interest: three figures, never merged ────────────────────

/**
 * The rate history behind the charged figure, shaped as the ledger serves it.
 * Two of the three windows were bound — scaled down to the interest RBC
 * actually printed — which is the normal case because total lending exceeds
 * the line, and is exactly why the factor has to be visible.
 */
const INTEREST_WINDOWS = [
  {
    rateWindowId: 1,
    fromDate: '2025-08-04',
    toDate: '2025-09-17',
    effectiveRate: '9.4400',
    applicableInterest: '38.6300',
    rawTotal: '92.0000',
    allocated: '38.6300',
    scalingFactor: '0.419891',
    bound: true,
  },
  {
    rateWindowId: 2,
    fromDate: '2025-09-18',
    toDate: '2025-10-29',
    effectiveRate: '9.1900',
    applicableInterest: '26.3500',
    rawTotal: '26.3500',
    allocated: '26.3500',
    scalingFactor: '1.000000',
    bound: false,
  },
  {
    rateWindowId: 3,
    fromDate: '2025-10-30',
    toDate: '2026-09-03',
    effectiveRate: '8.9400',
    applicableInterest: '172.3600',
    rawTotal: '400.0000',
    allocated: '172.3600',
    scalingFactor: '0.430900',
    bound: true,
  },
];

/** Stephen's real shape: 6,700 principal, 174.80 charged, 19.69 accrued. */
const LEDGER_WITH_INTEREST = {
  ...MOCK_LEDGER,
  loanBalance: [{ currency: 'CAD', lent: '6700.0000', repaid: '0.0000', balance: '6700.0000' }],
  // `repaid` is ALWAYS '0.0000' on an interest row — an allocation is not
  // repaid piecemeal, it is recomputed wholesale on the next allocator run.
  interestCharged: [{ currency: 'CAD', lent: '174.8000', repaid: '0.0000', balance: '174.8000' }],
  interestAccrued: [{ currency: 'CAD', lent: '19.6900', repaid: '0.0000', balance: '19.6900' }],
  interestWindows: INTEREST_WINDOWS,
  // Freshly allocated: the stored rows match what a recomputation would write.
  interestStaleness: {
    stale: false,
    persistedTotal: '237.3400',
    recomputedTotal: '237.3400',
    chargedThrough: '2026-09-03',
    statementThrough: '2026-09-03',
  },
};

const renderDrillIn = () =>
  render(
    <MemoryRouter initialEntries={['/planned/people?contact=1']}>
      <PeopleLedgerPage />
    </MemoryRouter>,
  );

describe('PeopleLedgerPage — interest drill-in', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue(LEDGER_WITH_INTEREST as never);
  });

  it('shows principal, charged and accrued as three separate figures', async () => {
    renderDrillIn();

    const block = await screen.findByTestId('owed-breakdown-CAD');
    expect(within(block).getByTestId('owed-principal-CAD')).toHaveTextContent('CAD 6,700.00');
    expect(within(block).getByTestId('owed-charged-CAD')).toHaveTextContent('CAD 174.80');
    expect(within(block).getByTestId('owed-accrued-CAD')).toHaveTextContent('CAD 19.69');

    // The merged number — 6,700 + 174.80 + 19.69 rendered as one unlabelled
    // "owed" figure with no breakdown — is the thing this page must never do.
    // The total is allowed only BECAUSE the three components stand above it.
    expect(within(block).getByTestId('owed-total-CAD')).toHaveTextContent('CAD 6,894.49');
  });

  it('names the provenance of each interest figure', async () => {
    renderDrillIn();

    const block = await screen.findByTestId('owed-breakdown-CAD');
    // Charged traces to a document: the last statement it was billed on.
    expect(within(block).getByTestId('owed-charged-caption-CAD')).toHaveTextContent('2026-09-03');
    // Accrued names the rate it was computed at, since there is no document.
    expect(within(block).getByTestId('owed-accrued-caption-CAD')).toHaveTextContent('8.940%');
  });

  it('labels the accrued figure an estimate, and says so on any total containing it', async () => {
    renderDrillIn();

    const block = await screen.findByTestId('owed-breakdown-CAD');
    expect(within(block).getByTestId('owed-accrued-CAD').textContent ?? '').toMatch(/estimate/i);
    // A total that silently swallows the estimate is the estimate laundered
    // into a billed fact — the exact failure this feature exists to remove.
    expect(within(block).getByTestId('owed-total-CAD').textContent ?? '').toMatch(/estimate/i);
  });

  it('shows the rate windows so a rate change is visible without leaving the page', async () => {
    renderDrillIn();

    const windows = await screen.findByTestId('interest-rate-windows');
    expect(windows).toHaveTextContent('9.440% to 2025-09-17');
    expect(windows).toHaveTextContent('9.190% to 2025-10-29');
    expect(windows).toHaveTextContent('8.940% since');
  });

  it('surfaces the scaling factor rather than hiding the bound windows', async () => {
    renderDrillIn();

    const scaling = await screen.findByTestId('interest-scaling');
    // 2 of 3 windows that allocated anything were scaled down to the printed
    // figure. A sudden change here means the lending or the line moved.
    expect(scaling).toHaveTextContent('2 of 3');
    expect(scaling.textContent ?? '').toMatch(/0\.42/);
  });

  it('draws no repaid leg for interest — an allocation has none', async () => {
    renderDrillIn();

    const block = await screen.findByTestId('owed-breakdown-CAD');
    // `repaid` is always '0.0000' on an interest row, so rendering a repaid leg
    // or a lent-vs-repaid bar would assert that nothing had been repaid.
    expect(within(block).queryByText(/repaid/i)).toBeNull();
    expect(within(block).queryByRole('img')).toBeNull();
  });

  it('shows no interest element at all for a contact with none', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...MOCK_LEDGER,
      interestCharged: [],
      interestAccrued: [],
      interestWindows: INTEREST_WINDOWS,
    } as never);

    renderDrillIn();

    await screen.findByTestId('ledger-summary-card');
    // Not `CAD 0.00`: a zero would read as "we computed this and it came to
    // nothing", a different and false claim from "this person has none".
    expect(screen.queryByTestId('owed-breakdown')).toBeNull();
    expect(screen.queryByTestId('owed-breakdown-CAD')).toBeNull();
    expect(screen.queryByTestId('interest-rate-windows')).toBeNull();
  });

  /**
   * Nothing runs the allocator automatically. Import a statement, don't press
   * the button, and the stored figure stops earlier than the live rate windows
   * do — so a caption naming the newest statement asserts coverage the number
   * does not have, and the days in the unallocated window fall into neither
   * charged nor accrued.
   */
  it('says the charged figure is stale instead of naming a statement it does not cover', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...LEDGER_WITH_INTEREST,
      interestStaleness: {
        stale: true,
        persistedTotal: '174.8000',
        recomputedTotal: '237.3400',
        chargedThrough: '2025-10-29',
        statementThrough: '2026-09-03',
      },
    } as never);

    renderDrillIn();

    const block = await screen.findByTestId('owed-breakdown-CAD');
    const caption = within(block).getByTestId('owed-charged-caption-CAD');
    // The newest statement is NOT what this figure covers, so it may not be
    // offered as the figure's through-date.
    expect(caption.textContent ?? '').toMatch(/stale/i);
    expect(caption).not.toHaveTextContent('through the 2026-09-03 statement');
    // What it does cover is fair to state.
    expect(caption).toHaveTextContent('2025-10-29');

    // And the page says what to do about it.
    const notice = await screen.findByTestId('interest-stale');
    expect(notice.textContent ?? '').toMatch(/reallocate/i);
  });

  /**
   * The scaling ratio describes a FRESH recomputation, not the stored rows. On
   * a stale ledger it is a summary of allocations that were never persisted, so
   * it may not be presented as a description of the figure above it.
   */
  it('does not describe a stale charged figure with the fresh scaling summary', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...LEDGER_WITH_INTEREST,
      interestStaleness: {
        stale: true,
        persistedTotal: '174.8000',
        recomputedTotal: '237.3400',
        chargedThrough: '2025-10-29',
        statementThrough: '2026-09-03',
      },
    } as never);

    renderDrillIn();

    const scaling = await screen.findByTestId('interest-scaling');
    expect(scaling.textContent ?? '').toMatch(/not yet saved|would|recomputation/i);
  });

  /**
   * The bound only scales DOWN. An unbound window leaves a residue attributed
   * to nobody, and the ratio alone hid it: `Interest charged · CAD 755.12` read
   * as a complete attribution while 23% of the billed interest was unaccounted
   * for.
   */
  it('names the gap between what RBC billed and what was attributed', async () => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue({
      ...LEDGER_WITH_INTEREST,
      interestWindows: [
        // Predates every loan: billed, nobody to attribute it to.
        {
          rateWindowId: 1,
          fromDate: '2025-01-01',
          toDate: '2025-01-31',
          effectiveRate: '9.4400',
          applicableInterest: '226.6400',
          rawTotal: '0.0000',
          allocated: '0.0000',
          scalingFactor: '1.000000',
          bound: false,
        },
        {
          rateWindowId: 2,
          fromDate: '2025-08-04',
          toDate: '2026-09-03',
          effectiveRate: '8.9400',
          applicableInterest: '755.1200',
          rawTotal: '2000.0000',
          allocated: '755.1200',
          scalingFactor: '0.377560',
          bound: true,
        },
      ],
    } as never);

    renderDrillIn();

    const gap = await screen.findByTestId('interest-attribution-gap');
    expect(gap).toHaveTextContent('755.12');
    expect(gap).toHaveTextContent('981.76');
    expect(gap).toHaveTextContent('226.64');
  });

  it('reallocates interest and reloads the ledger', async () => {
    const runSpy = vi
      .spyOn(api, 'runInterestAllocation')
      .mockResolvedValue({ windows: 3, allocations: 6, totalCharged: '174.8000' } as never);
    const ledgerSpy = vi
      .spyOn(api, 'getContactLedger')
      .mockResolvedValue(LEDGER_WITH_INTEREST as never);

    renderDrillIn();

    await screen.findByTestId('owed-breakdown-CAD');
    const before = ledgerSpy.mock.calls.length;
    await userEvent.click(screen.getByTestId('reallocate-interest'));

    await waitFor(() => expect(runSpy).toHaveBeenCalled());
    await waitFor(() => expect(ledgerSpy.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('PeopleLedgerPage — interest on the landing list and headline', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getContactLedger').mockResolvedValue(LEDGER_WITH_INTEREST as never);
  });

  it('shows interest beside the balance, not folded into it', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('contact-row-1');
    // The balance cell still reports principal alone.
    expect(within(row).getByTestId('balance-1')).toHaveTextContent('CAD 6,700.00 owed to you');
    const interest = within(row).getByTestId('interest-1');
    expect(interest).toHaveTextContent('CAD 194.49');
    // Part of that 194.49 is the accrued estimate, so the cell has to say so.
    expect(interest.textContent ?? '').toMatch(/estimate/i);
  });

  it('keeps principal and interest as separate headline tiles', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metrics = await screen.findByTestId('loan-balance-metrics');
    // Principal keeps its own tile, unchanged and uninflated.
    expect(within(metrics).getByText('CAD 6,700.00 owed to you')).toBeInTheDocument();
    // Charged and accrued each get their own — summing them would hide which
    // half moved, the same reason owedToYou and youOwe are separate.
    expect(within(metrics).getByText('Interest charged · CAD')).toBeInTheDocument();
    expect(within(metrics).getByText('Interest accrued (estimate) · CAD')).toBeInTheDocument();
    expect(within(metrics).getByText('CAD 174.80')).toBeInTheDocument();
    expect(within(metrics).getByText('CAD 19.69')).toBeInTheDocument();
  });

  /**
   * A failed fetch leaves the contact out of the ledger map, so the breakdown
   * comes back empty and the cell rendered `—` under the comment "This contact
   * has none. Not zero — none." For a row that failed to load that comment is
   * false: nothing is known about this contact's interest. The Balance cell two
   * columns left already says "Couldn't load"; this one must too.
   */
  it('says interest could not be loaded rather than claiming there is none', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      MOCK_CONTACT,
      { id: 2, name: 'Stephen', isSelf: false },
    ] as never);
    vi.spyOn(api, 'getContactLedger').mockImplementation((async (id: number) =>
      id === 1 ? LEDGER_WITH_INTEREST : Promise.reject(new Error('boom'))) as never);

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    // The loaded row still shows its interest, so the column is rendered.
    const loaded = await screen.findByTestId('contact-row-1');
    expect(within(loaded).getByTestId('interest-1')).toHaveTextContent('CAD 194.49');

    const failed = await screen.findByTestId('contact-row-2');
    const cell = within(failed).getByTestId('interest-cell-2');
    await waitFor(() => expect(cell).toHaveTextContent("Couldn't load"));
    // An em dash here would claim this contact has no interest. It is unknown.
    expect(cell.textContent ?? '').not.toMatch(/^\s*—\s*$/);
  });

  it('shows no interest tile or cell when nobody carries interest', async () => {
    // MOCK_LEDGER has no interest fields at all — an older server, or a
    // household whose statements have never been imported. Absent must render
    // as nothing, never as a confident `CAD 0.00`.
    vi.spyOn(api, 'getContactLedger').mockResolvedValue(MOCK_LEDGER as never);

    render(
      <MemoryRouter initialEntries={['/planned/people']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );

    const metrics = await screen.findByTestId('loan-balance-metrics');
    expect(within(metrics).queryByText(/Interest charged/)).toBeNull();
    expect(within(metrics).queryByText(/Interest accrued/)).toBeNull();
    expect(screen.queryByTestId('interest-1')).toBeNull();
  });
});
