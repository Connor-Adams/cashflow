import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const patchJson = vi.fn().mockResolvedValue({});
const postJson = vi.fn();
vi.mock('@/lib/api', () => ({
  patchJson: (...a: unknown[]) => patchJson(...a),
  postJson: (...a: unknown[]) => postJson(...a),
  getJson: vi.fn(),
}));

const reload = vi.fn();
const DEFAULT_QUEUE = {
  corpDistributions: [
    {
      personal: { id: 11, date: '2025-04-01', amount: '20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 1, accountName: 'Personal Chk', txnType: 'transfer' },
      corp: { id: 12, date: '2025-04-01', amount: '-20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 2, accountName: 'Corp Chk', txnType: 'transfer' },
    },
    {
      personal: { id: 13, date: '2025-05-01', amount: '15000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 1, accountName: 'Personal Chk', txnType: 'transfer' },
      corp: { id: 14, date: '2025-05-01', amount: '-15000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 2, accountName: 'Corp Chk', txnType: 'transfer' },
    },
  ],
  payroll: [
    { id: 21, date: '2025-07-01', amount: '3000', currency: 'CAD', merchantClean: 'Employer', accountId: 1, accountName: 'Personal Chk', txnType: 'income' },
  ],
};
let queueData: unknown = DEFAULT_QUEUE;
vi.mock('../../hooks/useClassificationQueue', () => ({
  useClassificationQueue: () => ({ data: queueData, error: null, loading: false, reload }),
}));
vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 5, kind: 'personal' }], error: null }),
}));

import { ClassifyTab } from './ClassifyTab';

/** The bulk endpoint echoes the rows it wrote; the tab applies those in place. */
function bulkEcho(rows: { id: number; amount: string }[], treatment: string) {
  return {
    updated: rows.map((r) => ({
      id: r.id,
      date: '2025-04-01',
      amount: r.amount,
      currency: 'CAD',
      merchantClean: 'Owner transfer',
      accountId: 1,
      accountName: 'Personal Chk',
      txnType: 'transfer',
      taxTreatmentOverride: treatment,
    })),
  };
}

describe('ClassifyTab', () => {
  beforeEach(() => {
    patchJson.mockClear();
    postJson.mockReset();
    reload.mockClear();
    queueData = DEFAULT_QUEUE;
  });

  it('renders corp + payroll sections and classifies a row (instant save + move)', async () => {
    render(<ClassifyTab year={2025} />);
    expect(screen.getByText(/Corp → personal/i)).toBeInTheDocument();
    expect(screen.getAllByText('Personal Chk').length).toBeGreaterThan(0);
    expect(screen.getByText(/Payroll/i)).toBeInTheDocument();
    const select = screen.getByLabelText('treatment for txn 11') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'non_eligible_dividend' } });
    await waitFor(() => {
      expect(patchJson).toHaveBeenCalledWith('/api/transfers/11/tax-treatment', { taxTreatmentOverride: 'non_eligible_dividend' });
    });
    expect(await screen.findByText(/Undo/i)).toBeInTheDocument();
  });

  it('shows an empty state when nothing is unclassified', () => {
    queueData = { corpDistributions: [], payroll: [] };
    render(<ClassifyTab year={2025} />);
    expect(screen.getByText(/No unclassified income/i)).toBeInTheDocument();
  });

  it('applies one treatment to several selected rows in a SINGLE request', async () => {
    postJson.mockResolvedValue(
      bulkEcho([{ id: 11, amount: '20000' }, { id: 13, amount: '15000' }], 'non_eligible_dividend'),
    );
    render(<ClassifyTab year={2025} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'select txn 11' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'select txn 13' }));
    fireEvent.change(screen.getByLabelText('bulk treatment for corp draws'), {
      target: { value: 'non_eligible_dividend' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Apply to 2/ }));

    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJson).toHaveBeenCalledWith('/api/tax/classification-queue/bulk', {
      ids: [11, 13],
      taxTreatmentOverride: 'non_eligible_dividend',
    });
    expect(patchJson).not.toHaveBeenCalled();
  });

  it('reflects the returned rows without refetching the queue', async () => {
    postJson.mockResolvedValue(
      bulkEcho([{ id: 11, amount: '20000' }, { id: 13, amount: '15000' }], 'non_eligible_dividend'),
    );
    render(<ClassifyTab year={2025} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'select all corp draws' }));
    fireEvent.change(screen.getByLabelText('bulk treatment for corp draws'), {
      target: { value: 'non_eligible_dividend' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Apply to 2/ }));

    expect(await screen.findByText(/Classified · 2/)).toBeInTheDocument();
    expect(screen.getByText(/\$20,000\.00 → Non-eligible dividend/)).toBeInTheDocument();
    expect(screen.getByText(/\$15,000\.00 → Non-eligible dividend/)).toBeInTheDocument();
    // Both corp rows left the pending list, so the section header is gone.
    expect(screen.queryByText(/Corp → personal/i)).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('select-all picks every row in its own section only', () => {
    render(<ClassifyTab year={2025} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'select all corp draws' }));

    expect(screen.getByRole('checkbox', { name: 'select txn 11' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'select txn 13' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'select txn 21' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /Apply to 2/ })).toBeInTheDocument();
  });

  it('sends nothing when no rows are selected', () => {
    render(<ClassifyTab year={2025} />);
    fireEvent.change(screen.getByLabelText('bulk treatment for corp draws'), {
      target: { value: 'non_eligible_dividend' },
    });
    // Both sections show an Apply button; neither may fire with an empty selection.
    const applies = screen.getAllByRole('button', { name: /Apply to 0/ });
    expect(applies).toHaveLength(2);
    for (const apply of applies) {
      expect(apply).toBeDisabled();
      fireEvent.click(apply);
    }
    expect(postJson).not.toHaveBeenCalled();
  });
});
