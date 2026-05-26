import { useState } from 'react'

export type CustomRangePickerProps = {
  from: string
  to: string
  onApply: (range: { from: string; to: string }) => void
}

export function CustomRangePicker({ from, to, onApply }: CustomRangePickerProps) {
  const [f, setF] = useState(from)
  const [t, setT] = useState(to)
  const valid = f && t && f <= t
  return (
    <div className="flex items-center gap-2 mt-2">
      <input type="date" value={f} onChange={(e) => setF(e.target.value)} className="border px-2 py-1 rounded" />
      <span className="text-sm">to</span>
      <input type="date" value={t} onChange={(e) => setT(e.target.value)} className="border px-2 py-1 rounded" />
      <button
        type="button"
        disabled={!valid}
        onClick={() => onApply({ from: f, to: t })}
        className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        Apply
      </button>
    </div>
  )
}
