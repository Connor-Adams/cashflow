import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MultiwaySplitEditor } from './MultiwaySplitEditor';

const contacts = [
  { id: 3, name: 'Dad' },
  { id: 7, name: 'Alex' },
];

describe('MultiwaySplitEditor', () => {
  it('even split shows each participant + your share read-out', () => {
    render(
      <MultiwaySplitEditor
        amountAbs={302.71}
        contacts={contacts}
        onApply={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    // add two participants
    fireEvent.click(screen.getByText('+ Add person'));
    fireEvent.change(screen.getAllByLabelText(/person/i)[0], { target: { value: '3' } });
    fireEvent.click(screen.getByText('+ Add person'));
    fireEvent.change(screen.getAllByLabelText(/person/i)[1], { target: { value: '7' } });
    // even split of 302.71 / 3 -> your share 100.91
    expect(screen.getByText(/your share/i)).toHaveTextContent('100.91');
  });

  it('apply calls onApply with method even and participant ids', () => {
    const onApply = vi.fn();
    render(
      <MultiwaySplitEditor amountAbs={90} contacts={contacts} onApply={onApply} onClear={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('+ Add person'));
    fireEvent.change(screen.getAllByLabelText(/person/i)[0], { target: { value: '3' } });
    fireEvent.click(screen.getByText(/apply split/i));
    expect(onApply).toHaveBeenCalledWith({
      method: 'even',
      participants: [{ contactId: 3 }],
      includeSelf: true,
    });
  });
});
