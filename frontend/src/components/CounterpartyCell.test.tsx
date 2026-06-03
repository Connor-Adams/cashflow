import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CounterpartyCell } from './CounterpartyCell';

const contacts = [
  { id: 7, householdId: 1, name: 'John', notes: null, isPartner: false },
  { id: 8, householdId: 1, name: 'Mom', notes: null, isPartner: false },
] as never;

describe('CounterpartyCell', () => {
  it('emits the chosen contact id', () => {
    const onChange = vi.fn();
    render(
      <CounterpartyCell value={null} contacts={contacts} onChange={onChange}
        onCreateContact={vi.fn()} onError={vi.fn()} txnId={1} />,
    );
    fireEvent.change(screen.getByLabelText(/counterparty for transaction 1/i), {
      target: { value: '7' },
    });
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it('emits null when cleared', () => {
    const onChange = vi.fn();
    render(
      <CounterpartyCell value={7} contacts={contacts} onChange={onChange}
        onCreateContact={vi.fn()} onError={vi.fn()} txnId={1} />,
    );
    fireEvent.change(screen.getByLabelText(/counterparty for transaction 1/i), {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('creates a contact inline and selects it', async () => {
    const onChange = vi.fn();
    const onCreateContact = vi.fn().mockResolvedValue({
      id: 99, householdId: 1, name: 'Zoe', notes: null, isPartner: false,
    });
    render(
      <CounterpartyCell value={null} contacts={contacts} onChange={onChange}
        onCreateContact={onCreateContact} onError={vi.fn()} txnId={1} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add new counterparty contact for transaction 1/i }));
    fireEvent.change(screen.getByLabelText(/new contact name/i), { target: { value: 'Zoe' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(onCreateContact).toHaveBeenCalledWith('Zoe'));
    expect(onChange).toHaveBeenCalledWith(99);
  });
});
