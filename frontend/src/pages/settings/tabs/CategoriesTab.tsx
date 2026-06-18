import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogBody,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CategoryIcon } from '../../../components/CategoryIcon'
import { CategoryIconPicker } from '../../../components/CategoryIconPicker'
import { useCategories } from '../../../lib/useCategories'
import { patchJson } from '../../../lib/api'
import { CategoryTreeManager } from './CategoryTreeManager'
import { TAX_TREATMENTS } from '../../../lib/taxTreatment'
import { TaxTreatmentSelect } from '../../../components/TaxTreatmentSelect'
import type { CategoryIconName } from '@cashflow/shared'
import type { TaxTreatment } from '../../../lib/taxTreatment'
import type { Category } from '../../../types/api'

export function CategoriesTab() {
  const { categories, refresh } = useCategories()
  const [editing, setEditing] = useState<Category | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function setIcon(cat: Category, next: CategoryIconName | null) {
    setErr(null)
    try {
      await patchJson<Category>(`/api/categories/${cat.id}`, { icon: next })
      await refresh()
      setEditing(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update icon')
    }
  }

  async function setTreatment(cat: Category, next: TaxTreatment) {
    setErr(null)
    try {
      await patchJson<Category>(`/api/categories/${cat.id}`, { taxTreatment: next })
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update tax treatment')
    }
  }

  return (
    <Card className="accountsFormCard">
      <div className="accountsCardHeader">
        <div>
          <h2>Categories</h2>
          <p className="muted">
            Pick an icon for each category. Icons appear in budgets, transactions,
            and the dashboard.
          </p>
        </div>
      </div>
      <h3 className="mt-2">Organize categories</h3>
      <p className="muted">Create subcategories, rename, drag to reparent, or delete.</p>
      <CategoryTreeManager />
      <h3 className="mt-4">Icons &amp; tax</h3>
      {err && <span className="error" role="alert">{err}</span>}
      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {categories.map((cat) => (
          <li key={cat.id} className="flex items-center gap-3 py-2">
            <CategoryIcon name={cat.name} size={20} />
            <span className="flex-1">{cat.name}</span>
            <TaxTreatmentSelect
              aria-label={`Tax treatment for ${cat.name}`}
              value={cat.taxTreatment}
              options={[...TAX_TREATMENTS]}
              onChange={(t) => { if (t) void setTreatment(cat, t); }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label={`Edit icon for ${cat.name}`}
              onClick={() => setEditing(cat)}
            >
              Change
            </Button>
          </li>
        ))}
      </ul>
      {editing && (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setEditing(null) }}
        >
          <DialogHeader>
            <DialogTitle>{`Icon for "${editing.name}"`}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <CategoryIconPicker
              value={(editing.icon as CategoryIconName | null) ?? null}
              onSelect={(next) => void setIcon(editing, next)}
            />
          </DialogBody>
        </Dialog>
      )}
    </Card>
  )
}
