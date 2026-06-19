/**
 * SyncPage — local-first encrypted backup & restore UI (Cashflow #239).
 *
 * Two flows live on this page:
 *   - Create encrypted backup → user enters a passphrase, server
 *     builds + encrypts the bundle, browser downloads it as
 *     `cashflow-backup-YYYY-MM-DD.cfbak.json`.
 *   - Restore from backup → user uploads the .cfbak.json, enters the
 *     passphrase, optionally previews counts before committing the
 *     restore. Replace mode lets them overwrite existing rows.
 *
 * The page is intentionally low-chrome — power-user safety surface.
 * Future cloud-sync work plugs into the same endpoints (see
 * docs/sync.md for the extension points).
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent } from '@cashflow/ui'
import { Button } from '@cashflow/ui'
import { Input } from '@cashflow/ui'
import { Alert } from '@cashflow/ui'
import { PageHeader } from '@/components/ui/page-header'
import { getJson, postJson } from '../lib/api'
import type {
  SyncBackupResponse,
  SyncHistoryResponse,
  SyncRestoreMode,
  SyncRestorePreviewResponse,
  SyncRestoreResponse,
} from '../types/api'

const MIN_PASSPHRASE_LEN = 8

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function todayStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function downloadBundle(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return 'Unknown error'
}

export function SyncPage() {
  const [history, setHistory] = useState<SyncHistoryResponse | null>(null)
  const [historyErr, setHistoryErr] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const res = await getJson<SyncHistoryResponse>('/api/sync/history')
      setHistory(res)
      setHistoryErr(null)
    } catch (e) {
      setHistoryErr(errMessage(e))
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  return (
    <div className="page">
      <PageHeader
        title="Backup & sync"
        description="Local-first encrypted backups. Your passphrase never leaves your device unless you choose to share it."
      />

      <BackupSection onComplete={loadHistory} />
      <RestoreSection onComplete={loadHistory} />
      <HistorySection history={history} error={historyErr} />
    </div>
  )
}

function BackupSection({ onComplete }: { onComplete: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<SyncBackupResponse | null>(null)

  const canSubmit =
    passphrase.length >= MIN_PASSPHRASE_LEN &&
    passphrase === confirmPassphrase &&
    !loading

  const handleBackup = useCallback(async () => {
    setError(null)
    setStatus(null)
    if (!canSubmit) return
    setLoading(true)
    try {
      const res = await postJson<SyncBackupResponse>('/api/sync/backup', {
        passphrase,
      })
      setLastResult(res)
      const filename = `cashflow-backup-${todayStamp()}.cfbak.json`
      const payload = JSON.stringify(
        {
          appVersion: res.origin,
          bundleVersion: res.bundleVersion,
          schemaVersion: res.schemaVersion,
          createdAt: res.createdAt,
          bundle: res.bundle,
        },
        null,
        2,
      )
      downloadBundle(payload, filename)
      setStatus(
        `Saved ${filename} (${bytesLabel(res.bundleBytes)}, ${res.rowCount} rows). Keep it safe — you'll need the same passphrase to restore.`,
      )
      onComplete()
      setPassphrase('')
      setConfirmPassphrase('')
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setLoading(false)
    }
  }, [canSubmit, passphrase, onComplete])

  return (
    <Card className="mt-4">
      <CardContent>
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-base font-semibold m-0">Create encrypted backup</h2>
            <p className="text-sm text-muted-foreground m-0 mt-1">
              Encrypts your household's accounts, transactions, categories,
              contacts, and rules with a passphrase. Downloads to your device —
              nothing is uploaded.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 flex flex-col gap-1 text-sm">
              <span className="font-medium">Passphrase</span>
              <Input
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="At least 8 characters"
              />
            </label>
            <label className="flex-1 flex flex-col gap-1 text-sm">
              <span className="font-medium">Confirm passphrase</span>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirmPassphrase}
                onChange={(e) => setConfirmPassphrase(e.target.value)}
                placeholder="Re-enter passphrase"
              />
            </label>
            <Button
              type="button"
              onClick={() => void handleBackup()}
              disabled={!canSubmit}
            >
              {loading ? 'Encrypting…' : 'Backup'}
            </Button>
          </div>
          {passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LEN && (
            <Alert variant="warning" title="Passphrase too short">
              Passphrase must be at least {MIN_PASSPHRASE_LEN} characters.
            </Alert>
          )}
          {confirmPassphrase.length > 0 && passphrase !== confirmPassphrase && (
            <Alert variant="warning" title="Passphrases don't match">
              The two passphrase fields must match exactly.
            </Alert>
          )}
          {status && (
            <Alert variant="success" title="Backup ready">
              {status}
            </Alert>
          )}
          {error && (
            <Alert variant="error" title="Backup failed">
              {error}
            </Alert>
          )}
          {lastResult && (
            <details className="text-sm">
              <summary className="cursor-pointer">
                Last backup contents ({lastResult.rowCount} rows)
              </summary>
              <ul className="mt-2 pl-5 list-disc">
                {Object.entries(lastResult.tableCounts).map(([table, n]) => (
                  <li key={table}>
                    {table}: {n}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

interface ParsedFile {
  bundle: string
  bundleVersion: number
  schemaVersion: number
  createdAt?: string
}

function parseUploadedFile(text: string): ParsedFile {
  // Tolerate either a wrapped JSON file (preferred — what backup
  // writes) or a raw base64 string (paste from clipboard).
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed) as Partial<ParsedFile>
    if (typeof obj.bundle !== 'string') {
      throw new Error('File is missing the encrypted bundle field')
    }
    return {
      bundle: obj.bundle,
      bundleVersion: Number(obj.bundleVersion ?? 1),
      schemaVersion: Number(obj.schemaVersion ?? 1),
      createdAt: obj.createdAt,
    }
  }
  return {
    bundle: trimmed,
    bundleVersion: 1,
    schemaVersion: 1,
  }
}

function RestoreSection({ onComplete }: { onComplete: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [parsedFile, setParsedFile] = useState<ParsedFile | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [mode, setMode] = useState<SyncRestoreMode>('merge')
  const [preview, setPreview] = useState<SyncRestorePreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [restoreLoading, setRestoreLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SyncRestoreResponse | null>(null)

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    setPreview(null)
    setResult(null)
    setFileName(file.name)
    try {
      const text = await file.text()
      const parsed = parseUploadedFile(text)
      setParsedFile(parsed)
    } catch (e) {
      setError(`Could not parse backup file: ${errMessage(e)}`)
      setParsedFile(null)
    }
  }, [])

  const runPreview = useCallback(async () => {
    if (!parsedFile || passphrase.length < MIN_PASSPHRASE_LEN) return
    setError(null)
    setPreview(null)
    setPreviewLoading(true)
    try {
      const res = await postJson<SyncRestorePreviewResponse>(
        '/api/sync/restore/preview',
        { passphrase, bundle: parsedFile.bundle },
      )
      setPreview(res)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setPreviewLoading(false)
    }
  }, [parsedFile, passphrase])

  const runRestore = useCallback(async () => {
    if (!parsedFile || passphrase.length < MIN_PASSPHRASE_LEN) return
    setError(null)
    setResult(null)
    setRestoreLoading(true)
    try {
      const res = await postJson<SyncRestoreResponse>('/api/sync/restore', {
        passphrase,
        bundle: parsedFile.bundle,
        mode,
      })
      setResult(res)
      onComplete()
      // Drop the passphrase from memory once the restore is done.
      setPassphrase('')
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setRestoreLoading(false)
    }
  }, [parsedFile, passphrase, mode, onComplete])

  const canSubmit =
    parsedFile != null &&
    passphrase.length >= MIN_PASSPHRASE_LEN &&
    !previewLoading &&
    !restoreLoading

  return (
    <Card className="mt-4">
      <CardContent>
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-base font-semibold m-0">Restore from backup</h2>
            <p className="text-sm text-muted-foreground m-0 mt-1">
              Upload a .cfbak.json file and supply the passphrase used at
              backup time. Preview the contents before applying.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Backup file</span>
            <input
              type="file"
              accept=".cfbak,.json,application/json,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleFile(f)
              }}
              className="text-sm"
            />
            {fileName && (
              <span className="text-xs text-muted-foreground mt-1">
                Selected: {fileName}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Passphrase</span>
            <Input
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Passphrase used at backup time"
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="font-medium">Restore mode</legend>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="mode"
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
                className="mt-1"
              />
              <span>
                <strong>Merge (safe)</strong> — only restore when your
                current household has no existing data. Refuses if it
                does. Pick this for a fresh install.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="mode"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
                className="mt-1"
              />
              <span>
                <strong>Replace (destructive)</strong> — delete the
                current household's accounts, categories, contacts,
                rules, and transactions before inserting the bundle.
                There's no undo.
              </span>
            </label>
          </fieldset>
          <div className="flex flex-row gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void runPreview()}
              disabled={!canSubmit}
            >
              {previewLoading ? 'Decrypting…' : 'Preview'}
            </Button>
            <Button
              type="button"
              onClick={() => void runRestore()}
              disabled={!canSubmit}
            >
              {restoreLoading ? 'Restoring…' : `Restore (${mode})`}
            </Button>
          </div>
          {preview && (
            <Alert variant="info" title="Bundle preview">
              <ul className="m-0 pl-4 list-disc text-sm">
                <li>Source household: {preview.sourceHouseholdId ?? '—'}</li>
                <li>Created: {new Date(preview.createdAt).toLocaleString()}</li>
                <li>Schema version: {preview.schemaVersion}</li>
                <li>Wire size: {bytesLabel(preview.bundleBytes)}</li>
                <li>Total rows: {preview.rowCount}</li>
                {Object.entries(preview.tableCounts).map(([t, n]) => (
                  <li key={t}>
                    {t}: {n}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          {result && (
            <Alert variant="success" title="Restore complete">
              <ul className="m-0 pl-4 list-disc text-sm">
                <li>Mode: {result.mode}</li>
                {Object.entries(result.inserted).map(([t, n]) => (
                  <li key={t}>
                    {t}: {n} rows restored
                  </li>
                ))}
                {Object.entries(result.skipped).map(([t, n]) => (
                  <li key={t}>
                    {t}: {n} rows skipped (unknown table)
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          {error && (
            <Alert variant="error" title="Restore failed">
              {error}
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function HistorySection({
  history,
  error,
}: {
  history: SyncHistoryResponse | null
  error: string | null
}) {
  return (
    <Card className="mt-4">
      <CardContent>
        <div className="flex flex-col gap-3">
          <h2 className="text-base font-semibold m-0">History</h2>
          {error && (
            <Alert variant="error" title="Couldn't load history">
              {error}
            </Alert>
          )}
          {history && history.data.length === 0 && (
            <p className="text-sm text-muted-foreground m-0">
              No backups yet. Your first backup will appear here.
            </p>
          )}
          {history && history.data.length > 0 && (
            <table className="text-sm w-full">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="font-medium py-1 pr-3">When</th>
                  <th className="font-medium py-1 pr-3">Kind</th>
                  <th className="font-medium py-1 pr-3">Size</th>
                  <th className="font-medium py-1 pr-3">Rows</th>
                  <th className="font-medium py-1">Bundle v / schema v</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((row) => {
                  const totalRows = Object.values(row.tableCounts).reduce(
                    (a, b) => a + b,
                    0,
                  )
                  return (
                    <tr key={row.id} className="border-t border-border">
                      <td className="py-1 pr-3">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="py-1 pr-3">{row.kind}</td>
                      <td className="py-1 pr-3">{bytesLabel(row.bundleBytes)}</td>
                      <td className="py-1 pr-3">{totalRows}</td>
                      <td className="py-1">
                        {row.bundleVersion} / {row.schemaVersion}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
