import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useToast } from '@/components/ui/toast'
import { postJson } from '@/lib/api'

type ImportResult = { imported: number; skipped: number; errors: string[] }

type Props = {
  onClose: () => void
  onImported: () => void
}

export function ImportRulesModal({ onClose, onImported }: Props) {
  const { showToast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<{ version?: number; rules?: unknown[] } | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [submitting, setSubmitting] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setParseError(null)
    setParsed(null)
    setConfirmReplace(false)
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 1024 * 1024) {
      setParseError('File too large (max 1MB)')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string) as { version?: number; rules?: unknown[] }
        if (json.version !== 1) {
          setParseError('Unsupported version — only version 1 is supported')
          return
        }
        setParsed(json)
      } catch {
        setParseError('Invalid JSON file')
      }
    }
    reader.readAsText(file)
  }

  async function handleSubmit() {
    if (!parsed) return
    if (mode === 'replace' && !confirmReplace) {
      setConfirmReplace(true)
      return
    }
    setSubmitting(true)
    try {
      const result = await postJson<ImportResult>('/api/rules/import', {
        rules: parsed?.rules ?? [],
        mode,
      })
      showToast({
        title: `Imported ${result.imported} rule${result.imported !== 1 ? 's' : ''}.`,
        variant: 'success',
      })
      onImported()
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : 'Import failed',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const ruleCount = parsed?.rules?.length ?? 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import rules"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <Card className="w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold">Import rules</h2>

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="import-rules-file">
            JSON file
          </label>
          <input
            id="import-rules-file"
            type="file"
            accept=".json"
            ref={fileRef}
            onChange={handleFile}
            className="text-sm"
          />
          {parseError && <p className="text-destructive text-xs mt-1">{parseError}</p>}
          {parsed && (
            <p className="text-sm text-muted-foreground mt-1">Found {ruleCount} rule{ruleCount !== 1 ? 's' : ''} in this file.</p>
          )}
        </div>

        <div>
          <p className="text-sm font-medium mb-1">Mode</p>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                value="append"
                checked={mode === 'append'}
                onChange={() => { setMode('append'); setConfirmReplace(false); }}
              /> Append
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                value="replace"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
              /> Replace all
            </label>
          </div>
          {mode === 'replace' && (
            <p className="text-xs text-amber-600 mt-1">Replace will delete all existing rules before importing.</p>
          )}
        </div>

        {confirmReplace && mode === 'replace' && (
          <div className="rounded-md border border-destructive bg-destructive/10 p-3">
            <p className="text-sm font-medium text-destructive">Are you sure? This will delete all existing rules.</p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!parsed || submitting || !!parseError}
            onClick={() => void handleSubmit()}
            variant={confirmReplace ? 'destructive' : 'default'}
          >
            {submitting ? 'Importing…' : confirmReplace ? 'Confirm replace' : 'Import'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
