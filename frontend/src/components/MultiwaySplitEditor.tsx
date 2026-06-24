import { useMemo, useState } from 'react'
import type { SplitTransactionRequest } from '@cashflow/shared'
import { NativeSelect, Input, Button } from '@connor-adams/designsystem'

export interface MultiwaySplitEditorProps {
  amountAbs: number
  contacts: Array<{ id: number; name: string }>
  onApply: (body: SplitTransactionRequest) => void
  onClear: () => void
}

interface Row {
  contactId: number | ''
  pct: string // percent input as string; ignored when even
}

export function MultiwaySplitEditor({
  amountAbs,
  contacts,
  onApply,
  onClear,
}: MultiwaySplitEditorProps) {
  const [even, setEven] = useState(true)
  const [rows, setRows] = useState<Row[]>([])

  const valid = rows.filter((r) => r.contactId !== '')

  const yourShare = useMemo(() => {
    if (valid.length === 0) return amountAbs
    if (even) {
      const n = valid.length + 1 // include self
      const each = Math.round((amountAbs / n) * 100) / 100
      return Math.round((amountAbs - each * valid.length) * 100) / 100
    }
    const others = valid.reduce((a, r) => a + (Number(r.pct) || 0), 0)
    return Math.round(((amountAbs * (100 - others)) / 100) * 100) / 100
  }, [valid, even, amountAbs])

  function addRow() {
    setRows((rs) => [...rs, { contactId: '', pct: '' }])
  }

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  function apply() {
    const participants = valid.map((r) =>
      even
        ? { contactId: Number(r.contactId) }
        : { contactId: Number(r.contactId), pct: Number(r.pct) },
    )
    onApply({ method: even ? 'even' : 'percent', participants, includeSelf: true })
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={even} onChange={(e) => setEven(e.target.checked)} />
        Even split
      </label>

      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <NativeSelect
            aria-label={`person ${i + 1}`}
            value={String(r.contactId)}
            onChange={(e) =>
              setRow(i, { contactId: e.target.value ? Number(e.target.value) : '' })
            }
          >
            <option value="">Select person…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
          {!even && (
            <Input
              type="number"
              aria-label={`percent ${i + 1}`}
              value={r.pct}
              onChange={(e) => setRow(i, { pct: e.target.value })}
              placeholder="%"
            />
          )}
        </div>
      ))}

      <Button type="button" variant="ghost" onClick={addRow}>
        + Add person
      </Button>

      <div className="text-sm">Your share: {yourShare.toFixed(2)}</div>

      <div className="flex gap-2">
        <Button type="button" onClick={apply} disabled={valid.length === 0}>
          Apply split
        </Button>
        <Button type="button" variant="ghost" onClick={onClear}>
          Clear split
        </Button>
      </div>
    </div>
  )
}
