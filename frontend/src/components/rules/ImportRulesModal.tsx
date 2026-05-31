import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { postJson } from '@/lib/api'

const MAX_FILE_BYTES = 1 * 1024 * 1024 // 1 MB

type ImportResult = {
  imported: number
  skipped: number
  errors: { name: string; reason: string }[]
}

type ExportPayload = {
  schemaVersion: number
  rules: unknown[]
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingRuleCount: number
  onImported: () => void
}

export function ImportRulesModal({
  open,
  onOpenChange,
  existingRuleCount,
  onImported,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [parsed, setParsed] = useState<ExportPayload | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [importing, setImporting] = useState(false)
  const { showToast } = useToast()

  function reset() {
    setParsed(null)
    setFileError(null)
    setShowConfirm(false)
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
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as ExportPayload
        if (data?.schemaVersion !== 1 || !Array.isArray(data.rules)) {
          setFileError("This file isn't a valid Cashflow rules export.")
          return
        }
        if (data.schemaVersion > 1) {
          setFileError('This file is from a newer version of Cashflow. Update and try again.')
          return
        }
        setParsed(data)
      } catch {
        setFileError("This file isn't a valid Cashflow rules export.")
      }
    }
    reader.readAsText(file)
  }

  async function doImport() {
    if (!parsed) return
    setImporting(true)
    try {
      const result = await postJson<ImportResult>('/api/rules/import', {
        json: parsed,
        mode,
      })
      const msg =
        result.errors.length > 0
          ? `Imported ${result.imported} rules, skipped ${result.errors.length} (see details).`
          : `Imported ${result.imported} rules.`
      showToast({ title: msg })
      handleClose()
      onImported()
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : 'Import failed.',
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
    }
  }

  function handleImportClick() {
    if (!parsed) return
    if (mode === 'replace' && existingRuleCount > 0) {
      setShowConfirm(true)
    } else {
      void doImport()
    }
  }

  if (showConfirm) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogHeader>
          <DialogTitle>Replace all rules?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm">
            This deletes {existingRuleCount} rule(s) and imports {parsed?.rules.length ?? 0} from
            the file. This cannot be undone.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowConfirm(false)} disabled={importing}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void doImport()} disabled={importing}>
            {importing ? 'Replacing…' : 'Replace'}
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogHeader>
        <DialogTitle>Import rules</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Rules file</label>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={handleFileChange}
            className="text-sm"
          />
          {fileError ? (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{fileError}</p>
          ) : null}
          {parsed ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Found {parsed.rules.length} rules in this file.
            </p>
          ) : null}
        </div>

        <div>
          <span className="block text-sm font-medium mb-1">Mode</span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === 'append' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setMode('append')}
            >
              Append
            </Button>
            <Button
              type="button"
              variant={mode === 'replace' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setMode('replace')}
            >
              Replace
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === 'append'
              ? 'Adds these rules to your existing ones.'
              : 'Deletes all current rules first.'}
          </p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={handleClose}>
          Cancel
        </Button>
        <Button
          variant={mode === 'replace' ? 'destructive' : 'primary'}
          onClick={handleImportClick}
          disabled={!parsed || importing}
        >
          {importing ? 'Importing…' : 'Import'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
