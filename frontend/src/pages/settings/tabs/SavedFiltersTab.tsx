import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, patchJson } from '../../../lib/api'
import type { SavedFilter } from '../../../components/transactions/SaveFilterModal'

/**
 * Settings → Saved Filters (issue #272, AC #5). Lists the user's saved filter
 * presets across all pages. Supports inline rename, delete (with confirm), and
 * reorder via up/down arrows.
 */
export function SavedFiltersTab() {
  const [filters, setFilters] = useState<SavedFilter[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [savingId, setSavingId] = useState<number | null>(null)
  const { showToast } = useToast()

  useEffect(() => {
    void loadFilters()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadFilters() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await getJson<SavedFilter[]>('/api/saved-filters?page=transactions')
      setFilters(rows)
    } catch {
      setErr("Couldn't load saved filters.")
    } finally {
      setLoading(false)
    }
  }

  function startEdit(filter: SavedFilter) {
    setEditingId(filter.id)
    setEditingName(filter.name)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditingName('')
  }

  async function saveEdit(filter: SavedFilter) {
    const next = editingName.trim()
    if (!next) return
    setSavingId(filter.id)
    try {
      const updated = await patchJson<SavedFilter>(`/api/saved-filters/${filter.id}`, { name: next })
      setFilters((prev) => prev?.map((f) => (f.id === filter.id ? updated : f)) ?? null)
      setEditingId(null)
      setEditingName('')
      showToast({ title: 'Filter renamed.', variant: 'success' })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'DUPLICATE_NAME') {
        showToast({ title: 'A filter with that name exists.', variant: 'destructive' })
      } else if (msg === 'INVALID_NAME') {
        showToast({ title: 'Name must be 1–64 characters.', variant: 'destructive' })
      } else {
        showToast({ title: "Couldn't rename filter. Try again.", variant: 'destructive' })
      }
    } finally {
      setSavingId(null)
    }
  }

  async function removeFilter(filter: SavedFilter) {
    if (!window.confirm(`Delete saved filter "${filter.name}"?`)) return
    try {
      await deleteReq(`/api/saved-filters/${filter.id}`)
      setFilters((prev) => prev?.filter((f) => f.id !== filter.id) ?? null)
      showToast({ title: `Deleted '${filter.name}'.`, variant: 'success' })
    } catch {
      showToast({ title: "Couldn't delete filter. Try again.", variant: 'destructive' })
    }
  }

  async function moveFilter(filter: SavedFilter, direction: 'up' | 'down') {
    if (!filters) return
    const idx = filters.findIndex((f) => f.id === filter.id)
    if (idx === -1) return
    if (direction === 'up' && idx === 0) return
    if (direction === 'down' && idx === filters.length - 1) return

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    const swapFilter = filters[swapIdx]

    // Swap positions
    const newPos = swapFilter.position
    const swapPos = filter.position

    // Optimistic update
    const next = filters.map((f) => {
      if (f.id === filter.id) return { ...f, position: newPos }
      if (f.id === swapFilter.id) return { ...f, position: swapPos }
      return f
    })
    // Re-sort after swap
    next.sort((a, b) => a.position - b.position || a.id - b.id)
    setFilters(next)

    try {
      await Promise.all([
        patchJson(`/api/saved-filters/${filter.id}`, { position: newPos }),
        patchJson(`/api/saved-filters/${swapFilter.id}`, { position: swapPos }),
      ])
    } catch {
      showToast({ title: "Couldn't reorder filters. Try again.", variant: 'destructive' })
      void loadFilters() // reload to restore server state
    }
  }

  return (
    <Card className="accountsFormCard">
      <div className="accountsCardHeader">
        <div>
          <h2>Saved filters</h2>
          <p className="muted">
            Manage your named filter presets. Rename or reorder them here; apply
            them from the Transactions page.
          </p>
        </div>
      </div>

      {err && (
        <span className="error" role="alert">
          {err}
        </span>
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : !filters || filters.length === 0 ? (
        <p className="muted">No saved filters yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Page</th>
              <th className="py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filters.map((filter, idx) => (
              <tr key={filter.id} className="border-t border-border">
                <td className="py-2">
                  {editingId === filter.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        maxLength={64}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveEdit(filter)
                          if (e.key === 'Escape') cancelEdit()
                        }}
                        style={{ maxWidth: '200px' }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={savingId === filter.id || !editingName.trim()}
                        onClick={() => void saveEdit(filter)}
                      >
                        {savingId === filter.id ? 'Saving…' : 'Save'}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={cancelEdit}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    filter.name
                  )}
                </td>
                <td className="py-2 text-muted-foreground">{filter.page}</td>
                <td className="py-2">
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label="Move up"
                      disabled={idx === 0}
                      onClick={() => void moveFilter(filter, 'up')}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label="Move down"
                      disabled={idx === filters.length - 1}
                      onClick={() => void moveFilter(filter, 'down')}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={`Rename ${filter.name}`}
                      disabled={editingId !== null}
                      onClick={() => startEdit(filter)}
                    >
                      Rename
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      aria-label={`Delete ${filter.name}`}
                      onClick={() => void removeFilter(filter)}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
