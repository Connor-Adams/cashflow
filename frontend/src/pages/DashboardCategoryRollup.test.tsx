// frontend/src/pages/DashboardCategoryRollup.test.tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DashboardCategorySection } from './DashboardCategorySection';
import type { RollupRow } from '../types/api';

const rows: RollupRow[] = [
  { categoryId: 1, currency: 'CAD', name: 'Work', path: 'Work', parentId: null, depth: 0, directTotal: 50, rolledTotal: 80 },
];

describe('DashboardCategorySection', () => {
  it('renders the rollup tree for the active currency', () => {
    render(<DashboardCategorySection categoryTree={rows} currency="CAD" />);
    expect(screen.getByText('Work')).toBeInTheDocument();
  });
});
