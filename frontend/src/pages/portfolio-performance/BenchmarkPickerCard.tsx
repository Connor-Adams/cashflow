import { useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { patchJson } from '../../lib/api'

export type BenchmarkPickerCardProps = {
  currentSymbol: string
  onChange: (next: string) => void
}

export function BenchmarkPickerCard({ currentSymbol, onChange }: BenchmarkPickerCardProps) {
  const [editing, setEditing] = useState(false)
  const [symbol, setSymbol] = useState(currentSymbol)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await patchJson<{ benchmarkSymbol: string }>('/api/household/benchmark', { benchmarkSymbol: symbol })
      onChange(res.benchmarkSymbol)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm">Benchmark: <strong>{currentSymbol}</strong></p>
        {!editing && (
          <Button type="button" variant="ghost" onClick={() => setEditing(true)} className="text-sm underline">Change</Button>
        )}
      </div>
      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <label className="text-sm">
            Symbol:
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="ml-2 border px-2 py-1 rounded"
              maxLength={16}
            />
          </label>
          <Button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="px-3 py-1 text-sm rounded disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      )}
    </Card>
  )
}
