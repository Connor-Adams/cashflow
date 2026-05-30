import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { postJson } from '../../lib/api'

const MAX_FILE_BYTES = 1024 * 1024 // 1 MB

type ImportResult = {
  imported: number
  skipped: number
  errors: { name: string; reason: string }[]
}

type ParsedPayload = {
  schemaVersion: unknown
  rules: unknown[]
}

export function ImportRulesModal({
  existingCount,
  onClose,
  onImported,
}: {
  existingCount: number
  onClose: () => void
  onImported: () => void
}) {
  const { showToast } = useToast()
  const confirm = useConfirm()
  const fileRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [parsed, setParsed] = useState<ParsedPayload | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setParseError(null)
    setParsed(null)
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setParseError('File too large.')
      return
    }
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string) as Record<string, unknown>
        if (typeof data.schemaVersion !== 'number' || !Array.isArray(data.rules)) {
          setParseError("This file isn't a valid Cashflow rules export.")
          return
        }
        if ((data.schemaVersion as number) > 1) {
          setParseError('This file is from a newer version of Cashflow. Update and try again.')
          return
        }
        setParsed({ schemaVersion: data.schemaVersion, rules: data.rules as unknown[] })
      } catch {
        setParseError("This file isn't a valid Cashflow rules export.")
      }
    }
    reader.readAsText(file)
  }

  async function submit() {
    if (!parsed) return

    if (mode === 'replace' && existingCount > 0) {
      const ok = await confirm({
        title: 'Replace all rules?',
        description: `This deletes ${existingCount} rule(s) and imports ${parsed.rules.length} from the file. This cannot be undone.`,
        confirmLabel: 'Replace',
        destructive: true,
      })
      if (!ok) return
    }

    setSubmitting(true)
    try {
      const res = await postJson<ImportResult>('/api/rules/import', {
        json: parsed,
        mode,
      })
      const msg =
        res.skipped > 0
          ? `Imported ${res.imported} rules. Skipped ${res.skipped} (see details).`
          : `Imported ${res.imported} rules.`
      showToast({ title: msg, variant: 'success' })
      onImported()
    } catch (e) {
      if (e instanceof Error && e.message === 'UNSUPPORTED_VERSION') {
        setParseError('This file is from a newer version of Cashflow. Update and try again.')
      } else {
        setParseError(e instanceof Error ? e.message : 'Import failed.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {confirm.dialog}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import rules"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <Card className="w-full max-w-md p-5">
          <h2 className="mb-4 text-lg font-semibold">Import rules</h2>

          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">File</span>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFile}
                disabled={submitting}
              />
            </label>

            {parseError && (
              <p className="error text-sm" role="alert">{parseError}</p>
            )}

            {parsed && (
              <p className="text-sm muted">
                Found {parsed.rules.length} rule{parsed.rules.length !== 1 ? 's' : ''} in this file.
              </p>
            )}

            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium mb-1">Mode</legend>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="importMode"
                  value="append"
                  checked={mode === 'append'}
                  onChange={() => setMode('append')}
                  disabled={submitting}
                />
                <span>
                  <strong>Append</strong>
                  <span className="muted ml-1">— Adds these rules to your existing ones.</span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="importMode"
                  value="replace"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                  disabled={submitting}
                />
                <span>
                  <strong>Replace</strong>
                  <span className="muted ml-1">— Deletes all current rules first.</span>
                </span>
              </label>
            </fieldset>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button
                type="button"
                variant={mode === 'replace' ? 'destructive' : 'default'}
                disabled={!parsed || submitting}
                onClick={() => void submit()}
              >
                {submitting ? 'Importing…' : 'Import'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}
