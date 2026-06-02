import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const patchJson = vi.fn().mockResolvedValue({});
vi.mock('@/lib/api', () => ({ patchJson: (...a: unknown[]) => patchJson(...a), getJson: vi.fn() }));

const reload = vi.fn();
let queueData: unknown = {
  corpDistributions: [
    {
      personal: { id: 11, date: '2025-04-01', amount: '20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 1, accountName: 'Personal Chk', txnType: 'transfer' },
      corp: { id: 12, date: '2025-04-01', amount: '-20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 2, accountName: 'Corp Chk', txnType: 'transfer' },
    },
  ],
  payroll: [
    { id: 21, date: '2025-07-01', amount: '3000', currency: 'CAD', merchantClean: 'Employer', accountId: 1, accountName: 'Personal Chk', txnType: 'income' },
  ],
};
vi.mock('../../hooks/useClassificationQueue', () => ({
  useClassificationQueue: () => ({ data: queueData, error: null, loading: false, reload }),
}));
vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 5, kind: 'personal' }], error: null }),
}));

import { ClassifyTab } from './ClassifyTab';

describe('ClassifyTab', () => {
  beforeEach(() => { patchJson.mockClear(); reload.mockClear(); });

  it('renders corp + payroll sections and classifies a row (instant save + move)', async () => {
    render(<ClassifyTab year={2025} />);
    expect(screen.getByText(/Corp → personal/i)).toBeInTheDocument();
    expect(screen.getByText('Personal Chk')).toBeInTheDocument();
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
});
