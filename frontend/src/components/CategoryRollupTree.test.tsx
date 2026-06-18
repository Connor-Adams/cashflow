// frontend/src/components/CategoryRollupTree.test.tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CategoryRollupTree } from './CategoryRollupTree';
import type { RollupRow } from '../types/api';

const rows: RollupRow[] = [
  { categoryId: 1, currency: 'CAD', name: 'Work', path: 'Work', parentId: null, depth: 0, directTotal: 50, rolledTotal: 80 },
  { categoryId: 2, currency: 'CAD', name: 'Internet', path: 'Work / Internet', parentId: 1, depth: 1, directTotal: 30, rolledTotal: 30 },
  { categoryId: 9, currency: 'USD', name: 'Other', path: 'Other', parentId: null, depth: 0, directTotal: 5, rolledTotal: 5 },
];

describe('CategoryRollupTree', () => {
  it('renders roots for the active currency with rolled totals; child hidden until expanded', async () => {
    render(<CategoryRollupTree rows={rows} currency="CAD" />);
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.queryByText('Internet')).not.toBeInTheDocument(); // collapsed
    expect(screen.queryByText('Other')).not.toBeInTheDocument();    // wrong currency
    await userEvent.click(screen.getByRole('button', { name: /expand Work/i }));
    expect(screen.getByText('Internet')).toBeInTheDocument();
  });

  it('renders nothing meaningful when no rows for the currency', () => {
    const { container } = render(<CategoryRollupTree rows={rows} currency="GBP" />);
    expect(container.textContent).not.toContain('Work');
  });
});
