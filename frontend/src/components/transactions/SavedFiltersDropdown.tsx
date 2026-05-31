import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, Check, ChevronDown, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { deleteReq, getJson, patchJson, postJson } from '@/lib/api'
import { useToast } from '@/components/ui/toast'

export type FilterSnapshot = {
  reviewOnly: boolean
  currency: string
  dateFrom: string
  dateTo: string
  categoryFilter: string
  batchFilter: string
  statusFilter: string
  labelsFilter: number[]
}

type SavedFilter = {
  id: number
  name: string
  page: string
  filterJson: FilterSnapshot
  position: number
}

function snapshotEqual(a: FilterSnapshot, b: FilterSnapshot): boolean {
  return (
    a.reviewOnly === b.reviewOnly &&
    a.currency === b.currency &&
    a.dateFrom === b.dateFrom &&
    a.dateTo === b.dateTo &&
    a.categoryFilter === b.categoryFilter &&
    a.batchFilter === b.batchFilter &&
    a.statusFilter === b.statusFilter &&
    JSON.stringify(a.labelsFilter) === JSON.stringify(b.labelsFilter)
  )
}

type Props = {
  current: FilterSnapshot
  onApply: (snapshot: FilterSnapshot) => void
}

export function SavedFiltersDropdown({ current, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<SavedFilter[]>([])
  const [loading, setLoading] = useState(false)
  const [appliedId, setAppliedId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameName, setRenameName] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()

  const loadFilters = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getJson<SavedFilter[]>('/api/saved-filters?page=transactions')
      setFilters(data)
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void loadFilters()
  }, [open, loadFilters])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const appliedFilter = filters.find((f) => f.id === appliedId) ?? null
  const isModified = appliedFilter != null && !snapshotEqual(current, appliedFilter.filterJson)

  async function handleSave() {
    const name = saveName.trim()
    if (!name) {
      setSaveError('Name is required.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const created = await postJson<SavedFilter>('/api/saved-filters', {
        name,
        page: 'transactions',
        filterJson: current,
      })
      setFilters((prev) => [...prev, created])
      setAppliedId(created.id)
      setSaveName('')
      setShowSaveForm(false)
      showToast({ title: `Filter saved as "${name}".` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error'
      if (msg.includes('DUPLICATE_NAME')) {
        setSaveError(`A filter named "${name}" already exists.`)
      } else {
        setSaveError('Couldn\'t save filter. Try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdate() {
    if (!appliedFilter) return
    try {
      const updated = await patchJson<SavedFilter>(`/api/saved-filters/${appliedFilter.id}`, {
        filterJson: current,
      })
      setFilters((prev) => prev.map((f) => (f.id === updated.id ? updated : f)))
      showToast({ title: `Updated "${appliedFilter.name}".` })
    } catch {
      showToast({ title: 'Couldn\'t update filter.', variant: 'destructive' })
    }
  }

  async function handleDelete(id: number, name: string) {
    try {
      await deleteReq(`/api/saved-filters/${id}`)
      setFilters((prev) => prev.filter((f) => f.id !== id))
      if (appliedId === id) setAppliedId(null)
      showToast({ title: `Deleted "${name}".` })
    } catch {
      showToast({ title: 'Couldn\'t delete filter.', variant: 'destructive' })
    }
  }

  async function handleRename(id: number) {
    const name = renameName.trim()
    if (!name) return
    try {
      const updated = await patchJson<SavedFilter>(`/api/saved-filters/${id}`, { name })
      setFilters((prev) => prev.map((f) => (f.id === updated.id ? updated : f)))
      setRenamingId(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('DUPLICATE_NAME')) {
        showToast({ title: `A filter named "${name}" already exists.`, variant: 'destructive' })
      } else {
        showToast({ title: 'Couldn\'t rename filter.', variant: 'destructive' })
      }
    }
  }

  function apply(f: SavedFilter) {
    onApply(f.filterJson)
    setAppliedId(f.id)
    setOpen(false)
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5"
      >
        <Bookmark className="h-3.5 w-3.5" />
        Saved filters
        {isModified && <span className="text-muted-foreground text-xs">· modified</span>}
        <ChevronDown className="h-3.5 w-3.5 ml-0.5" />
      </Button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-72 rounded-lg border bg-background shadow-lg py-1">
          <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Saved filters
          </div>

          {loading && (
            <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
          )}

          {!loading && filters.length === 0 && !showSaveForm && (
            <div className="px-3 py-2 text-sm text-muted-foreground">No saved filters yet.</div>
          )}

          {!loading && filters.map((f) => (
            <div key={f.id} className="group flex items-center gap-1 px-2 py-1 hover:bg-muted/50">
              {renamingId === f.id ? (
                <div className="flex items-center gap-1 flex-1">
                  <Input
                    size={1}
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRename(f.id)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    className="h-6 text-xs"
                    autoFocus
                  />
                  <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => void handleRename(f.id)}>
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setRenamingId(null)}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="flex-1 text-left text-sm truncate py-0.5"
                    onClick={() => apply(f)}
                  >
                    {f.name}
                    {f.id === appliedId && !isModified && (
                      <Check className="inline h-3 w-3 ml-1 text-emerald-500" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-foreground text-muted-foreground"
                    onClick={() => { setRenamingId(f.id); setRenameName(f.name) }}
                    title="Rename"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive text-muted-foreground"
                    onClick={() => void handleDelete(f.id, f.name)}
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          ))}

          {isModified && appliedFilter && (
            <div className="border-t mt-1 pt-1 px-2">
              <button
                type="button"
                className="w-full text-left text-xs px-1 py-1 text-muted-foreground hover:text-foreground"
                onClick={() => void handleUpdate()}
              >
                Update "{appliedFilter.name}"
              </button>
            </div>
          )}

          <div className="border-t mt-1 pt-1">
            {showSaveForm ? (
              <div className="px-2 py-1 space-y-1">
                <Input
                  placeholder="Filter name…"
                  value={saveName}
                  onChange={(e) => { setSaveName(e.target.value); setSaveError(null) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSave()
                    if (e.key === 'Escape') setShowSaveForm(false)
                  }}
                  className="h-7 text-sm"
                  autoFocus
                />
                {saveError && <p className="text-xs text-destructive">{saveError}</p>}
                <div className="flex gap-1">
                  <Button size="sm" className="h-7 text-xs" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowSaveForm(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="w-full text-left text-sm px-3 py-1.5 hover:bg-muted/50 text-muted-foreground"
                onClick={() => setShowSaveForm(true)}
              >
                Save current filter…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
