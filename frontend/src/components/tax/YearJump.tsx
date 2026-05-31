import { useEffect, useId, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  years: number[]
  value: number | null
  onChange: (year: number) => void
  className?: string
}

export interface YearJumpHandle {
  focus(): void
}

export const YearJump = forwardRef<YearJumpHandle, Props>(function YearJump(
  { years, value, onChange, className },
  ref,
) {
  const listId = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useImperativeHandle(ref, () => ({
    focus() {
      inputRef.current?.focus()
      inputRef.current?.select()
    },
  }))

  const filtered = query.trim()
    ? years.filter((y) => String(y).includes(query.trim()))
    : years

  function select(year: number) {
    onChange(year)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); return }
    if (e.key === 'Enter') {
      if (filtered.length === 1) { select(filtered[0]); e.preventDefault(); return }
      const exact = filtered.find((y) => String(y) === query.trim())
      if (exact !== undefined) { select(exact); e.preventDefault() }
    }
  }

  function onBlur(e: React.FocusEvent) {
    if (listRef.current?.contains(e.relatedTarget as Node)) return
    setOpen(false)
    setQuery('')
  }

  const displayValue = open ? query : (value !== null ? String(value) : '')

  return (
    <div className={cn('relative inline-block', className)}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Tax year"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={displayValue}
        placeholder="Year"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={onBlur}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onKeyDown={onKeyDown}
        className="w-20 rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Tax years"
          className="absolute z-50 mt-1 max-h-48 w-24 overflow-y-auto rounded border border-border bg-popover shadow-md"
        >
          {filtered.map((y) => (
            <li
              key={y}
              role="option"
              aria-selected={y === value}
              onMouseDown={(e) => { e.preventDefault(); select(y) }}
              className={cn(
                'cursor-pointer px-2 py-1 text-sm hover:bg-accent hover:text-accent-foreground',
                y === value && 'font-medium text-foreground',
              )}
            >
              {y}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})
