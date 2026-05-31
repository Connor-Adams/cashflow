import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getJson } from '../../lib/api'
import { SaveFilterModal, type SavedFilterRecord } from './SaveFilterModal'

type Props = {
  currentFilters: Record<string, string>
  onApply: (filterJson: Record<string, string>) => void
  className?: string
}

export function SavedFiltersDropdown({ currentFilters, onApply, className }: Props) {
  const [open, setOpen] = useState(false)
  const [savedFilters, setSavedFilters] = useState<SavedFilterRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement | null>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Load saved filters when dropdown opens
  useEffect(() => {
    if (!open) return
    setLoading(true)
    void getJson<SavedFilterRecord[]>('/api/saved-filters?page=transactions')
      .then((data) => setSavedFilters(data))
      .catch(() => {
        // Silently fail — the dropdown will just be empty
      })
      .finally(() => setLoading(false))
  }, [open])

  function handleApply(filter: SavedFilterRecord) {
    onApply(filter.filterJson as Record<string, string>)
    setOpen(false)
  }

  function handleSaved(savedFilter: SavedFilterRecord) {
    setSavedFilters((prev) => {
      // Replace if same id, else prepend
      const exists = prev.some((f) => f.id === savedFilter.id)
      return exists ? prev.map((f) => (f.id === savedFilter.id ? savedFilter : f)) : [savedFilter, ...prev]
    })
  }

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }} className={className}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Saved filters
      </Button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 50,
            marginTop: 4,
            minWidth: 200,
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: '4px 0',
          }}
        >
          {loading && (
            <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--muted-foreground)' }}>
              Loading…
            </div>
          )}
          {!loading && savedFilters.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--muted-foreground)' }}>
              No saved filters yet.
            </div>
          )}
          {!loading &&
            savedFilters.map((filter) => (
              <button
                key={filter.id}
                role="menuitem"
                type="button"
                onClick={() => handleApply(filter)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  fontSize: 13,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--fg)',
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLElement).style.background = 'var(--muted)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLElement).style.background = 'none'
                }}
              >
                {filter.name}
              </button>
            ))}
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false)
              setSaveModalOpen(true)
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 12px',
              fontSize: 13,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--fg)',
            }}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLElement).style.background = 'var(--muted)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLElement).style.background = 'none'
            }}
          >
            Save current filter…
          </button>
        </div>
      )}
      <SaveFilterModal
        open={saveModalOpen}
        currentFilters={currentFilters}
        onClose={() => setSaveModalOpen(false)}
        onSaved={handleSaved}
      />
    </div>
  )
}
