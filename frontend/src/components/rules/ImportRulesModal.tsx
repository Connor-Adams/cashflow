import { useRef, useState } from 'react'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  useConfirm,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { postJson } from '@/lib/api'

const MAX_FILE_BYTES = 1_000_000

type ExportedRule = {
  merchantPattern: string
  matchKind: string
  priority: number
  category: string | null
  isBusiness: boolean
  splitType: string
  pctMe: string | null
  pctPartner: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
}

type RulesExport = {
  schemaVersion: number
  exportedAt: string
  rules: ExportedRule[]
}

type ImportResult = {
  imported: number
  skipped: number
  errors: { name: string; reason: string }[]
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRuleCount: number
  onSuccess: () => void
}

export function ImportRulesModal({ open, onOpenChange, currentRuleCount, onSuccess }: Props) {
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [parsed, setParsed] = useState<RulesExport | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const confirm = useConfirm()
  const { showToast } = useToast()

  function reset() {
    setParsed(null)
    setFileError(null)
    setLoading(false)
    setMode('append')
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleClose() {
    reset()
    onOpenChange(false)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null)
    setParsed(null)
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setFileError('File too large.')
      return
    }
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string) as unknown
        if (!data || typeof data !== 'object' || !('schemaVersion' in data)) {
          setFileError("This file isn't a valid Cashflow rules export.")
          return
        }
        const typed = data as RulesExport
        if (typeof typed.schemaVersion !== 'number') {
          setFileError("This file isn't a valid Cashflow rules export.")
          return
        }
        if (typed.schemaVersion > 1) {
          setFileError('This file is from a newer version of Cashflow. Update and try again.')
          return
        }
        if (typed.schemaVersion !== 1 || !Array.isArray(typed.rules)) {
          setFileError("This file isn't a valid Cashflow rules export.")
          return
        }
        setParsed(typed)
      } catch {
        setFileError("This file isn't a valid Cashflow rules export.")
      }
    }
    reader.readAsText(file)
  }

  async function handleSubmit() {
    if (!parsed) return

    if (mode === 'replace' && currentRuleCount > 0) {
      const ok = await confirm({
        title: 'Replace all rules?',
        description: `This deletes ${currentRuleCount} rule(s) and imports ${parsed.rules.length} from the file. This cannot be undone.`,
        confirmLabel: 'Replace',
        cancelLabel: 'Cancel',
        destructive: true,
      })
      if (!ok) return
    }

    setLoading(true)
    try {
      const result = await postJson<ImportResult>('/api/rules/import', {
        mode,
        json: parsed,
      })
      const msg =
        result.skipped > 0
          ? `Imported ${result.imported} rules. Skipped ${result.skipped} rule(s) (see details)`
          : `Imported ${result.imported} rules.`
      showToast({ title: msg, variant: 'success' })
      onSuccess()
      handleClose()
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Import failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
    {confirm.dialog}
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogHeader>
        <DialogTitle>Import rules</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Rules file</label>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileChange}
              className="block w-full text-sm"
            />
            {fileError && (
              <p className="mt-1 text-sm text-rose-600 dark:text-rose-400">{fileError}</p>
            )}
            {parsed && !fileError && (
              <p className="mt-1 text-sm text-positive">
                Found {parsed.rules.length} rule{parsed.rules.length !== 1 ? 's' : ''} in this file.
              </p>
            )}
          </div>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Mode</legend>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="import-mode"
                  value="append"
                  checked={mode === 'append'}
                  onChange={() => setMode('append')}
                />
                <span className="text-sm">
                  <span className="font-medium">Append</span>
                  <span className="ml-1 text-muted-foreground">— Adds these rules to your existing ones.</span>
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="import-mode"
                  value="replace"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                />
                <span className="text-sm">
                  <span className="font-medium">Replace</span>
                  <span className="ml-1 text-muted-foreground">— Deletes all current rules first.</span>
                </span>
              </label>
            </div>
          </fieldset>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={handleClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant={mode === 'replace' ? 'destructive' : 'primary'}
          onClick={() => void handleSubmit()}
          disabled={!parsed || !!fileError || loading}
        >
          {loading ? 'Importing…' : 'Import'}
        </Button>
      </DialogFooter>
    </Dialog>
    </>
  )
}

