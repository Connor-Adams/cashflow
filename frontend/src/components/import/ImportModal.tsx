/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChangeEvent, DragEvent, FormEvent } from 'react'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Alert, type AlertVariant } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getJson, postFormData } from '../../lib/api'
import { formatParseErrorLines } from '../../lib/formatParseErrors'
import type { Account } from '../../types/api'

type CsvProfileOption = { id: string; label: string; hint: string }

type DetectedMode = 'standard' | 'ws-bundle' | 'holdings' | 'pdf-bundle'

type UploadResult = {
  file?: string
  inserted?: number | null
  insertedTransactions?: number | null
  insertedInvestmentActivities?: number | null
  insertedHoldings?: number | null
  skippedDuplicates?: number | null
  rowErrors?: number | null
  batchLabel?: string | null
  warning?: string
  warnings?: string[]
  skipped?: boolean
  reason?: string | null
  message?: string | null
  parseErrors?: { rowIndex: number; message: string }[]
  error?: string | null
}

type PdfBatchItem = {
  fileName: string
  status: string
  accountName: string | null
  insertedTransactions: number
  insertedInvestmentActivities: number
  insertedHoldings: number
  skippedDuplicates: number
  error: string | null
}

type PdfBatchStatus = {
  id: string
  status: 'pending' | 'processing' | 'done' | 'failed'
  total: number
  processed: number
  succeeded: number
  failed: number
  items: PdfBatchItem[]
}

type WsBundleFileResult = {
  file: string
  accountShortCode: string | null
  inserted: number
  rowErrors: number
  parseErrors: { rowIndex: number; message: string }[]
  skipped?: boolean
  reason?: string | null
  error?: string
}

type MultiUploadResponse = { results: UploadResult[] }

const PDF_BUNDLE_URL = '/api/import/upload-pdf-bundle'
const WS_BUNDLE_URL = '/api/import/upload-bundle'
const HOLDINGS_URL = '/api/import/upload-holdings'
const SINGLE_URL = '/api/import/upload'
const MULTI_URL = '/api/import/upload-many'

const MODE_LABELS: Record<DetectedMode, string> = {
  'pdf-bundle': 'PDF statement bundle',
  'ws-bundle': 'Wealthsimple CSV bundle',
  holdings: 'Wealthsimple holdings CSV',
  standard: 'CSV / OFX / QFX statement',
}

const MODE_DESCRIPTIONS: Record<DetectedMode, string> = {
  'pdf-bundle':
    'Auto-detects issuer (RBC, CIBC, Questrade, Wealthsimple). Accounts created on first sight from the PDF body and matched by account number (last 4 for banks/cards, full ID for Wealthsimple brokerage).',
  'ws-bundle':
    'Multi-file Wealthsimple activity CSV import. Accounts auto-created per file by shortCode.',
  holdings: 'Single Wealthsimple positions CSV. Updates portfolio holdings.',
  standard:
    'Single CSV / OFX / QFX statement targeted at one account. CSV profile auto-detected unless overridden.',
}

// Wealthsimple bulk-export filename patterns. Mirror of
// backend/src/import/parseWealthsimpleFilename.ts (CREDIT_CARD_RE / MONTHLY_RE) —
// keep in sync. A CSV only routes to the WS bundle importer when its NAME matches
// one of these. Generic bank statement exports that merely contain the words
// "monthly-statement" (e.g. RBC "Chequing-monthly-statement-transactions-…") must
// stay in standard mode, or they get shoved through the WS activity parser.
const WS_CREDIT_CARD_RE =
  /^Wealthsimple-credit-card-\d{4}-\d{2}-\d{2}-credit-card-statement-transactions-ca-credit-card-[A-Za-z0-9]+\.csv$/
const WS_MONTHLY_RE =
  /^.+?-\d{4}-\d{2}-\d{2}-monthly-statement-transactions-[A-Za-z0-9]+CAD?\.csv$/

function isWealthsimpleExport(name: string): boolean {
  return WS_CREDIT_CARD_RE.test(name) || WS_MONTHLY_RE.test(name)
}

// eslint-disable-next-line react-refresh/only-export-components
export function detectMode(files: File[]): DetectedMode {
  if (files.length === 0) return 'standard'
  const allPdf = files.every((f) => f.name.toLowerCase().endsWith('.pdf'))
  if (allPdf) return 'pdf-bundle'
  const allCsv = files.every((f) => f.name.toLowerCase().endsWith('.csv'))
  if (allCsv) {
    if (
      files.length === 1 &&
      /holdings|positions/i.test(files[0].name)
    ) {
      return 'holdings'
    }
    // Only auto-route to the WS bundle importer when every file is a recognized
    // Wealthsimple bulk export. A mix, or a look-alike bank file, stays standard.
    if (files.every((f) => isWealthsimpleExport(f.name))) return 'ws-bundle'
  }
  return 'standard'
}

/**
 * Build the feedback banner for a single-file standard import. A parse-only
 * failure (0 rows inserted, rows errored) is surfaced as a loud error with a
 * wrong-profile hint, instead of the old quiet "Imported 0 row(s)" success that
 * made a totally-failed import look fine.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function singleImportFeedback(
  result: UploadResult,
  profileId: string,
): { variant: AlertVariant; title: string } {
  if (result.skipped) {
    return {
      variant: 'warning',
      title: `Skipped (${result.reason ?? 'unknown'}) — ${result.message ?? ''}`,
    }
  }
  const inserted = result.inserted ?? 0
  const rowErrors = result.rowErrors ?? result.parseErrors?.length ?? 0
  if (inserted === 0 && rowErrors > 0) {
    const prof =
      profileId && profileId !== 'auto' ? ` using the "${profileId}" profile` : ''
    return {
      variant: 'error',
      title: `Import failed — 0 of ${rowErrors} row(s) could be parsed${prof}. This usually means the wrong CSV profile; switch the profile to "Auto" or a bank-specific one and re-import.`,
    }
  }
  return {
    variant: rowErrors > 0 ? 'warning' : 'success',
    title: `Imported ${inserted} row(s) · batch "${result.batchLabel ?? ''}" · dupes ${result.skippedDuplicates ?? 0}${rowErrors > 0 ? ` · ${rowErrors} parse error(s)` : ''}`,
  }
}

type ImportModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: Account[]
  onCommitted: () => void
  onAccountsChanged?: () => void
}

export function ImportModal({
  open,
  onOpenChange,
  accounts,
  onCommitted,
  onAccountsChanged,
}: ImportModalProps) {
  const navigate = useNavigate()
  const [files, setFiles] = useState<File[]>([])
  const [autoMode, setAutoMode] = useState<DetectedMode>('standard')
  const [overrideMode, setOverrideMode] = useState<DetectedMode | null>(null)
  const mode = overrideMode ?? autoMode
  const [accountId, setAccountId] = useState('')
  const [batchLabel, setBatchLabel] = useState('')
  const [profileId, setProfileId] = useState('auto')
  const [csvProfiles, setCsvProfiles] = useState<CsvProfileOption[]>([])
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ variant: AlertVariant; title: string; lines?: string[] } | null>(null)
  const [batch, setBatch] = useState<{ id: string; total: number } | null>(null)
  const [batchStatus, setBatchStatus] = useState<PdfBatchStatus | null>(null)
  const [showProgressLink, setShowProgressLink] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    void getJson<CsvProfileOption[]>('/api/import/profiles')
      .then((list) => {
        setCsvProfiles(list)
        setProfileId((prev) => (list.some((p) => p.id === prev) ? prev : list[0]?.id ?? 'auto'))
      })
      .catch(() => {})
  }, [open])

  // Recompute auto-detected mode whenever the file list changes.
  useEffect(() => {
    const detected = detectMode(files)
    setAutoMode(detected)
    setOverrideMode(null)
  }, [files])

  // Poll the batch progress when a batch is in flight.
  useEffect(() => {
    if (!batch) return
    let active = true
    const tick = async () => {
      try {
        const s = await getJson<PdfBatchStatus>(`/api/import/pdf-batch/${batch.id}`)
        if (!active) return
        setBatchStatus(s)
        if (s.status === 'done' || s.status === 'failed') {
          if (s.succeeded > 0) onCommitted()
          return
        }
      } catch { /* keep polling */ }
      if (active) setTimeout(tick, 2000)
    }
    void tick()
    return () => { active = false }
  }, [batch, onCommitted])

  // Clear stale batch progress when the modal closes so a reopen is fresh.
  useEffect(() => {
    if (!open) { setBatch(null); setBatchStatus(null) }
  }, [open])

  function reset() {
    setFiles([])
    setBatchLabel('')
    setOverrideMode(null)
    setFeedback(null)
    setBatch(null)
    setBatchStatus(null)
    setShowProgressLink(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list)
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}::${f.size}`))
      const merged = [...prev]
      for (const f of incoming) {
        const key = `${f.name}::${f.size}`
        if (!seen.has(key)) {
          merged.push(f)
          seen.add(key)
        }
      }
      return merged
    })
    setFeedback(null)
  }

  function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (files.length === 0) {
      setFeedback({ variant: 'error', title: 'Pick at least one file.' })
      return
    }
    if (mode === 'standard' && !accountId) {
      setFeedback({ variant: 'error', title: 'Pick a target account for this statement.' })
      return
    }
    setBusy(true)
    setFeedback(null)
    try {
      if (mode === 'pdf-bundle') {
        const fd = new FormData()
        files.forEach((f) => fd.append('files', f))
        const { batchId, total } = await postFormData<{ batchId: string; total: number }>(PDF_BUNDLE_URL, fd)
        setBatch({ id: batchId, total })
        setFeedback({ variant: 'success', title: `Uploaded ${total} file(s); processing…` })
        setShowProgressLink(true)
        // Clear the file list so the drop-zone is ready, but keep the batch/feedback visible
        setFiles([])
        setOverrideMode(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
        return
      } else if (mode === 'ws-bundle') {
        const fd = new FormData()
        files.forEach((f) => fd.append('files', f))
        const { results } = await postFormData<{ results: WsBundleFileResult[] }>(WS_BUNDLE_URL, fd)
        const ok = results.filter((r) => !r.error && !r.skipped).length
        const inserted = results.reduce((s, r) => s + r.inserted, 0)
        const lines = results
          .slice(0, 8)
          .map((r) => `${r.file}: ${r.skipped ? `skipped (${r.reason ?? 'unknown'})` : r.error ? `ERR: ${r.error}` : `${r.inserted} row(s)`}`)
        setFeedback({
          variant: ok === results.length ? 'success' : 'warning',
          title: `WS bundle: ${ok}/${results.length} imported · ${inserted} row(s)`,
          lines,
        })
        if (onAccountsChanged) onAccountsChanged()
        else onCommitted()
        reset()
      } else if (mode === 'holdings') {
        const fd = new FormData()
        fd.append('file', files[0])
        const result = await postFormData<{
          inserted?: number
          updated?: number
          warnings?: string[]
          errors?: string[]
          statementDate?: string | null
        }>(HOLDINGS_URL, fd)
        setFeedback({
          variant: result.errors?.length ? 'warning' : 'success',
          title: `Holdings imported${result.statementDate ? ` as of ${result.statementDate}` : ''} — ${result.inserted ?? 0} inserted, ${result.updated ?? 0} updated`,
          lines: [
            ...(result.warnings ?? []),
            ...(result.errors ?? []),
          ],
        })
        onCommitted()
        reset()
      } else {
        // standard: single or multi CSV/OFX
        const fd = new FormData()
        fd.append('accountId', accountId)
        if (batchLabel.trim()) fd.append('batchLabel', batchLabel.trim())
        fd.append('profileId', profileId)
        if (files.length === 1) {
          fd.append('file', files[0])
          const result = await postFormData<UploadResult>(SINGLE_URL, fd)
          const fb = singleImportFeedback(result, profileId)
          setFeedback({
            ...fb,
            lines: result.parseErrors?.length ? formatParseErrorLines(result.parseErrors) : undefined,
          })
          // Keep the staged file on a hard failure so the user can switch the
          // CSV profile and re-import without re-selecting it.
          if (fb.variant === 'error') return
        } else {
          files.forEach((f) => fd.append('files', f))
          const out = await postFormData<MultiUploadResponse>(MULTI_URL, fd)
          const imported = out.results.filter((r) => !r.skipped).length
          const inserted = out.results.reduce((s, r) => s + (r.inserted ?? 0), 0)
          setFeedback({
            variant: 'success',
            title: `Imported ${inserted} row(s) across ${imported}/${out.results.length} file(s)`,
            lines: out.results.slice(0, 8).map((r) => `${r.file}: ${r.skipped ? `skipped (${r.reason ?? 'unknown'})` : `${r.inserted ?? 0} row(s)`}`),
          })
        }
        onCommitted()
        reset()
      }
    } catch (err) {
      setFeedback({
        variant: 'error',
        title: err instanceof Error ? err.message : 'Import failed',
      })
    } finally {
      setBusy(false)
    }
  }

  const totalBytes = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o)
      }}
      className="max-w-4xl"
    >
      <DialogHeader>
        <DialogTitle>Import statements</DialogTitle>
        <DialogDescription>
          Drag and drop one or more files. Mode is auto-detected from the file
          mix — override on the right if needed.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-4 p-4">
          {/* Left: drop zone + file list */}
          <div className="flex flex-col gap-3">
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`rounded-md border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
                dragOver ? 'bg-accent border-primary' : 'border-border hover:bg-accent/40'
              }`}
            >
              <p className="text-sm font-medium">
                Drop files here or click to choose
              </p>
              <p className="text-xs muted mt-1">
                PDF · CSV · OFX · QFX — multi-select OK
              </p>
              <Input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.csv,.ofx,.qfx,application/pdf"
                onChange={onFileInput}
                className="hidden"
              />
            </div>
            {files.length > 0 && (
              <div className="rounded-md border border-border">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border text-xs muted">
                  <span>{files.length} file(s) · {(totalBytes / 1024).toFixed(1)} KB</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="underline"
                    onClick={() => setFiles([])}
                  >
                    Clear
                  </Button>
                </div>
                <ul className="max-h-64 overflow-y-auto text-sm">
                  {files.map((f, i) => (
                    <li
                      key={`${f.name}-${i}`}
                      className="flex items-center justify-between px-3 py-1.5 border-b border-border last:border-b-0"
                    >
                      <span className="truncate" title={f.name}>{f.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="muted hover:text-foreground ml-2 text-xs"
                        onClick={() => removeFile(i)}
                        aria-label={`Remove ${f.name}`}
                      >
                        ×
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Right: side pane */}
          <aside className="flex flex-col gap-3 text-sm">
            <div>
              <Label className="text-xs uppercase muted">Detected mode</Label>
              <select
                value={mode}
                onChange={(e) => setOverrideMode(e.target.value as DetectedMode)}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 mt-1"
              >
                {(Object.keys(MODE_LABELS) as DetectedMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m]}
                    {m === autoMode ? ' (auto)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs muted mt-1">{MODE_DESCRIPTIONS[mode]}</p>
            </div>

            {mode === 'standard' && (
              <>
                <div>
                  <Label className="text-xs uppercase muted">Target account</Label>
                  <select
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 mt-1"
                  >
                    <option value="">— pick one —</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs uppercase muted">CSV profile</Label>
                  <select
                    value={profileId}
                    onChange={(e) => setProfileId(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 mt-1"
                  >
                    {csvProfiles.map((p) => (
                      <option key={p.id} value={p.id} title={p.hint}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            <div>
              <Label className="text-xs uppercase muted">Batch label (optional)</Label>
              <Input
                value={batchLabel}
                onChange={(e) => setBatchLabel(e.target.value)}
                placeholder="auto-generated"
                className="mt-1"
              />
            </div>
          </aside>
        </div>

        {feedback && (
          <div className="px-4 pb-2">
            <Alert variant={feedback.variant} title={feedback.title} />
            {feedback.lines && feedback.lines.length > 0 && (
              <ul className="mt-2 text-xs muted max-h-48 overflow-y-auto rounded-md border border-border p-2">
                {feedback.lines.map((line, i) => (
                  <li key={i} className="truncate" title={line}>
                    {line}
                  </li>
                ))}
              </ul>
            )}
            {showProgressLink && (
              <div className="mt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs underline underline-offset-2 text-blue-600 dark:text-blue-400 hover:opacity-80"
                  onClick={() => { onOpenChange(false); navigate('/imports') }}
                >
                  View progress →
                </Button>
              </div>
            )}
          </div>
        )}

        {batchStatus && (
          <div className="px-4 pb-2">
            <Alert
              variant={batchStatus.status === 'failed' ? 'error' : batchStatus.status === 'done' ? 'success' : 'info'}
              title={`Processing ${batchStatus.processed}/${batchStatus.total} · ${batchStatus.succeeded} ok, ${batchStatus.failed} failed${batchStatus.status === 'done' ? ' · done' : ''}`}
            />
            {batchStatus.items.length > 0 && (
              <ul className="mt-2 text-xs muted max-h-48 overflow-y-auto rounded-md border border-border p-2">
                {batchStatus.items.map((it, i) => (
                  <li key={i} className="truncate" title={it.error ?? ''}>
                    {it.fileName} → {it.accountName ?? '—'} · {it.status}
                    {it.status === 'done' ? ` (txn=${it.insertedTransactions} act=${it.insertedInvestmentActivities} hld=${it.insertedHoldings} skip=${it.skippedDuplicates})` : ''}
                    {it.error ? ` · ERR: ${it.error}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Close
          </Button>
          <Button type="submit" disabled={busy || files.length === 0}>
            {busy ? 'Importing…' : `Import ${files.length || ''}`.trim()}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
