// frontend/src/pages/DashboardCategorySection.tsx
import { Card } from '@cashflow/ui';
import { CategoryRollupTree } from '../components/CategoryRollupTree';
import type { RollupRow } from '../types/api';

export function DashboardCategorySection({ categoryTree, currency }: { categoryTree: RollupRow[]; currency: string }) {
  return (
    <Card className="dashboardTile">
      <h3>Categories</h3>
      <p className="muted">Spending rolled up by category. Expand a parent to see subcategories.</p>
      <CategoryRollupTree rows={categoryTree} currency={currency} />
    </Card>
  );
}
