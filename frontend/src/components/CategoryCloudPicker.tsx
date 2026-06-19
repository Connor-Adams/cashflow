import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@cashflow/ui'
import { CategoryIcon } from './CategoryIcon'

function arrangeOptionsBySpace(options: string[]): string[] {
  const byLength = [...options].sort((a, b) => {
    const lengthDiff = b.length - a.length
    return lengthDiff !== 0 ? lengthDiff : a.localeCompare(b)
  })
  const out: string[] = []
  let left = 0
  let right = byLength.length - 1
  while (left <= right) {
    out.push(byLength[left])
    left += 1
    if (left <= right) {
      out.push(byLength[right])
      right -= 1
    }
  }
  return out
}

type CategoryCloudPickerProps = {
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
  className?: string
  inputClassName?: string
  cloudClassName?: string
  itemClassName?: string
}

export function CategoryCloudPicker({
  value,
  onChange,
  options,
  placeholder,
  className,
  inputClassName,
  cloudClassName,
  itemClassName,
}: CategoryCloudPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  const arrangedOptions = useMemo(
    () => arrangeOptionsBySpace(options),
    [options]
  )

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!rootRef.current?.contains(target)) setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className={['categoryCloudPicker', className].filter(Boolean).join(' ')}
    >
      <input
        className={inputClassName}
        value={value}
        placeholder={placeholder}
        aria-expanded={open}
        aria-haspopup="listbox"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
      />
      {open && arrangedOptions.length > 0 ? (
        <div
          className={['categoryCloudPicker__cloud', cloudClassName]
            .filter(Boolean)
            .join(' ')}
          role="listbox"
        >
          {arrangedOptions.map((option) => (
            <Button
              key={option}
              type="button"
              variant="ghost"
              size="sm"
              className={['categoryCloudPicker__item', itemClassName]
                .filter(Boolean)
                .join(' ')}
              aria-pressed={value === option}
              role="option"
              aria-selected={value === option}
              onMouseDown={(event) => {
                event.preventDefault()
              }}
              onClick={() => {
                onChange(option)
                setOpen(false)
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <CategoryIcon name={option} />
                {option}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
