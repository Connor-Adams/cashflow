import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ChevronDown, ChevronUp, Edit3, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useConfirm,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label as FieldLabel } from '@/components/ui/label'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, patchJson } from '../../../lib/api'
import type { SavedFilter } from '../../../components/transactions/SavedFiltersDropdown'

export function SavedFiltersTab() {
  const [filters, setFilters] = useState<SavedFilter[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<SavedFilter | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const [renameSaving, setRenameSaving] = useState(false)
  const confirm = useConfirm()
  const { showToast } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getJson<SavedFilter[]>('/api/saved-filters?page=transactions')
      setFilters(data)
    } catch {
      setErr("Couldn't load saved filters.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function remove(f: SavedFilter) {
    const ok = await confirm({
      title: 'Delete saved filter',
      description: `Delete saved filter '${f.name}'? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setErr(null)
    try {
      await deleteReq(`/api/saved-filters/${f.id}`)
      setFilters((prev) => prev.filter((x) => x.id !== f.id))
      showToast({ title: `Deleted '${f.name}'.` })
    } catch {
      setErr("Couldn't delete saved filter. Try again.")
    }
  }

  function openRename(f: SavedFilter) {
    setRenameTarget(f)
    setRenameValue(f.name)
    setRenameErr(null)
  }

  function closeRename() {
    setRenameTarget(null)
    setRenameValue('')
    setRenameErr(null)
    setRenameSaving(false)
  }

  async function submitRename(e?: FormEvent<HTMLFormElement>) {
    if (e) e.preventDefault()
    if (!renameTarget) return
    const name = renameValue.trim()
    if (!name) return
    setRenameSaving(true)
    setRenameErr(null)
    try {
      const updated = await patchJson<SavedFilter>(`/api/saved-filters/${renameTarget.id}`, { name })
      setFilters((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
      closeRename()
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('DUPLICATE_NAME')) {
        setRenameErr('A filter with that name exists.')
      } else {
        setRenameErr("Couldn't rename. Try again.")
      }
      setRenameSaving(false)
    }
  }

  async function move(f: SavedFilter, direction: 'up' | 'down') {
    const idx = filters.indexOf(f)
    if (idx < 0) return
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= filters.length) return
    const other = filters[swapIdx]
    const newPos = other.position
    const otherNewPos = f.position
    try {
      const [updatedF, updatedOther] = await Promise.all([
        patchJson<SavedFilter>(`/api/saved-filters/${f.id}`, { position: newPos }),
        patchJson<SavedFilter>(`/api/saved-filters/${other.id}`, { position: otherNewPos }),
      ])
      setFilters((prev) => {
        const next = [...prev]
        next[idx] = updatedF
        next[swapIdx] = updatedOther
        return next.sort((a, b) => a.position - b.position || a.id - b.id)
      })
    } catch {
      setErr("Couldn't reorder filters. Try again.")
    }
  }

  return (
    <Card className="accountsFormCard">
      <div className="accountsCardHeader">
        <div>
          <h2>Saved filters</h2>
          <p className="muted">
            Saved filter presets for the Transactions page. Rename, delete, or
            reorder them here.
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
      ) : filters.length === 0 ? (
        <p className="muted">
          No saved filters yet. Use the "Saved filters" dropdown on the
          Transactions page to save your first preset.
        </p>
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
            {filters.map((f, idx) => (
              <tr key={f.id} className="border-t border-border">
                <td className="py-2 font-medium">{f.name}</td>
                <td className="py-2 text-muted-foreground">{f.page}</td>
                <td className="py-2">
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label="Move up"
                      disabled={idx === 0}
                      onClick={() => void move(f, 'up')}
                    >
                      <ChevronUp className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label="Move down"
                      disabled={idx === filters.length - 1}
                      onClick={() => void move(f, 'down')}
                    >
                      <ChevronDown className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={`Rename ${f.name}`}
                      onClick={() => openRename(f)}
                    >
                      <Edit3 className="size-3.5" aria-hidden />
                      Rename
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      aria-label={`Delete ${f.name}`}
                      onClick={() => void remove(f)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {renameTarget && (
        <Dialog open onOpenChange={(open) => { if (!open) closeRename() }}>
          <DialogHeader>
            <DialogTitle>Rename filter</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitRename}>
            <DialogBody>
              <FieldLabel htmlFor="saved-filter-rename">
                Name
                <Input
                  id="saved-filter-rename"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  maxLength={64}
                  required
                  autoComplete="off"
                />
              </FieldLabel>
              {renameErr && (
                <p className="mt-1 text-sm text-red-600" role="alert">
                  {renameErr}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeRename}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  renameSaving ||
                  !renameValue.trim() ||
                  renameValue.trim() === renameTarget.name
                }
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}
      {confirm.dialog}
    </Card>
  )
}
