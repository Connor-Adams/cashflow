import { Card } from '@connor-adams/designsystem'
import { CategoryTreeManager } from './CategoryTreeManager'

export function CategoriesTab() {
  return (
    <Card className="accountsFormCard">
      <div className="accountsCardHeader">
        <div>
          <h2>Categories</h2>
          <p className="muted">
            Create subcategories, rename, drag to reparent, and set each
            category&apos;s icon and tax treatment. Click a category&apos;s icon to
            edit it. Icons appear in budgets, transactions, and the dashboard.
          </p>
        </div>
      </div>
      <CategoryTreeManager />
    </Card>
  )
}
