import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

void React;

const patchJson = vi.fn().mockResolvedValue({});
vi.mock('@/lib/api', () => ({ patchJson: (...a: unknown[]) => patchJson(...a), getJson: vi.fn() }));

const reload = vi.fn();
const CLASSIFIED_QUEUE = {
  corpDistributions: [
    {
      personal: { id: 11, date: '2025-04-01', amount: '20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 1, accountName: 'Personal Chk', txnType: 'transfer', taxTreatmentOverride: 'non_eligible_dividend' },
      corp: { id: 12, date: '2025-04-01', amount: '-20000', currency: 'CAD', merchantClean: 'Owner transfer', accountId: 2, accountName: 'Corp Chk', txnType: 'transfer', taxTreatmentOverride: 'non_eligible_dividend' },
    },
  ],
  payroll: [
    { id: 21, date: '2025-07-01', amount: '3000', currency: 'CAD', merchantClean: 'Employer', accountId: 1, accountName: 'Personal Chk', txnType: 'income', taxTreatmentOverride: 'employment_income' },
  ],
};
let queueData: unknown = CLASSIFIED_QUEUE;
vi.mock('../../hooks/useClassificationQueue', () => ({
  useClassificationQueue: () => ({ data: queueData, error: null, loading: false, reload }),
}));
vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 5, kind: 'personal' }], error: null }),
}));

import { ClassifiedTab } from './ClassifiedTab';

describe('ClassifiedTab', () => {
  beforeEach(() => { patchJson.mockClear(); reload.mockClear(); queueData = CLASSIFIED_QUEUE; });

  it('renders classified rows with the current treatment pre-selected', () => {
    render(<ClassifiedTab year={2025} />);
    const corpSelect = screen.getByLabelText('treatment for txn 11') as HTMLSelectElement;
    expect(corpSelect.value).toBe('non_eligible_dividend');
    const paySelect = screen.getByLabelText('treatment for txn 21') as HTMLSelectElement;
    expect(paySelect.value).toBe('employment_income');
  });

  it('reclassifies a corp pair to a new treatment via the both-legs transfers endpoint and reloads', async () => {
    render(<ClassifiedTab year={2025} />);
    const select = screen.getByLabelText('treatment for txn 11') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'loan_advance' } });
    await waitFor(() => {
      expect(patchJson).toHaveBeenCalledWith('/api/transfers/11/tax-treatment', { taxTreatmentOverride: 'loan_advance' });
    });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('clears a treatment (sends it back to the queue) by selecting the empty option', async () => {
    render(<ClassifiedTab year={2025} />);
    const select = screen.getByLabelText('treatment for txn 21') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => {
      expect(patchJson).toHaveBeenCalledWith('/api/transfers/21/tax-treatment', { taxTreatmentOverride: null });
    });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('shows an empty state when nothing is classified', () => {
    queueData = { corpDistributions: [], payroll: [] };
    render(<ClassifiedTab year={2025} />);
    expect(screen.getByText(/No classified income/i)).toBeInTheDocument();
  });
});
