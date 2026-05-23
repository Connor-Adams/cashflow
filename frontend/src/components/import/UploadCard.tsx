import { Fragment, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Alert, type AlertVariant } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getJson, postFormData, postJson } from '../../lib/api'
import { formatParseErrorLines } from '../../lib/formatParseErrors'
import type { Account, StatementPreview } from '../../types/api'

type UploadResult = {
  file: string
  batchLabel?: string
  inserted?: number
  skippedDuplicates?: number
  rowErrors?: number
  parseErrors?: { rowIndex: number; message: string }[]
  skipped?: boolean
  reason?: string
  message?: string
  warning?: string
  usedProfileId?: string
  profileInferred?: boolean
  insertedTransactions?: number
  insertedInvestmentActivities?: number
  insertedHoldings?: number
  warnings?: string[]
}

type FolderImportResponse = {
  results: UploadResult[]
  uploadDir: string
}

type MultiUploadResponse = {
  results: UploadResult[]
}

/**
 * Per-file result from the Wealthsimple bundle endpoint
 * (POST /api/import/upload-bundle). Mirrors backend `BundleFileResult`.
 */
type BundleFileResult = {
  file: string
  wsid: string | null
  accountId: number | null
  accountName: string | null
  accountCreated: boolean
  inserted: number
  insertedTransactions: number
  insertedInvestmentActivities: number
  skippedDuplicates: number
  rowErrors: number
  parseErrors: { rowIndex: number; message: string }[]
  warnings: string[]
  error?: string
}

type BundleUploadResponse = {
  results: BundleFileResult[]
}

/**
 * Per-file result from the Wealthsimple holdings/positions endpoint
 * (POST /api/import/upload-holdings). Mirrors backend `HoldingsImportResult`.
 */
type HoldingsResult = {
  file: string
  statementDate: string | null
  totalRows: number
  inserted: number
  updated: number
  skippedUnknownAccount: number
  warnings: string[]
  errors: string[]
  accountsAffected: number
}

/** Which upload form is currently rendered. */
type UploadMode = 'standard' | 'bundle' | 'holdings'

type CsvProfileOption = { id: string; label: string; hint: string }

type PreviewResponse = StatementPreview

function classifyUploadMessage(message: string): 'warning' | 'success' {
  if (
    message.includes('No rows') ||
    message.includes('duplicate') ||
    message.includes('Skipped')
  ) {
    return 'warning'
  }
  return 'success'
}

function summarizeUploadResult(result: UploadResult): string {
  if (result.skipped) {
    return [
      `Skipped (${result.reason ?? 'unknown'}): ${result.file}`,
      result.message,
    ]
      .filter(Boolean)
      .join(' — ')
  }
  const profileNote =
    result.usedProfileId != null
      ? `Profile: ${result.usedProfileId}${result.profileInferred ? ' (auto-detected)' : ''}`
      : ''
  return [
    result.insertedInvestmentActivities != null || result.insertedHoldings != null
      ? `Imported ${result.inserted ?? 0} record(s): ${result.insertedTransactions ?? 0} transactions, ${result.insertedInvestmentActivities ?? 0} activities, ${result.insertedHoldings ?? 0} holdings · batch “${result.batchLabel ?? ''}” · dupes skipped: ${result.skippedDuplicates ?? 0}`
      : `Imported ${result.inserted ?? 0} row(s) · batch “${result.batchLabel ?? ''}” · dupes skipped: ${result.skippedDuplicates ?? 0}`,
    profileNote,
    (result.rowErrors ?? 0) > 0
      ? `${result.rowErrors} row(s) could not be parsed`
      : '',
    result.warning,
    result.warnings?.length ? `${result.warnings.length} warning(s)` : '',
  ]
    .filter(Boolean)
    .join(' — ')
}

type UploadCardProps = {
  /** Accounts list rendered in the account picker. Owned by parent so it
   *  stays in sync with other surfaces (e.g. the transactions table). */
  accounts: Account[]
  /** Fires after a successful commit, multi-upload, bundle upload, or
   *  folder import so the caller can refresh import history / accounts. */
  onCommitted: () => void
  /** Optional — fired after the Wealthsimple bundle commit creates new
   *  accounts so the caller can re-fetch the accounts list. Falls back to
   *  `onCommitted` if not supplied. */
  onAccountsChanged?: () => void
}

/**
 * Statement upload card extracted from `TransactionsPage`. Hosts the two
 * upload modes (standard CSV/OFX/QFX vs Wealthsimple bundle), the file
 * picker, the preview flow, and the folder-import button. Lives on its own
 * `/import` route now — parent owns nothing but `accounts` + the
 * `onCommitted` callback that refreshes downstream lists.
 */
export function UploadCard({
  accounts,
  onCommitted,
  onAccountsChanged,
}: UploadCardProps) {
  const [uploadAccountId, setUploadAccountId] = useState('')
  const [batchLabel, setBatchLabel] = useState('')
  const [csvProfileOptions, setCsvProfileOptions] = useState<CsvProfileOption[]>(
    []
  )
  const [profileId, setProfileId] = useState('auto')
  // Unified upload feedback — replaces the prior trio (uploadMsg, uploadParseLines,
  // previewErr) so error/warning/info/success states render through one Alert.
  const [uploadFeedback, setUploadFeedback] = useState<{
    variant: AlertVariant
    title: string
    lines?: string[]
  } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [runningFolderImport, setRunningFolderImport] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null)
  const [mode, setMode] = useState<UploadMode>('standard')
  const [bundleUploading, setBundleUploading] = useState(false)
  const [bundleResults, setBundleResults] = useState<BundleFileResult[] | null>(
    null,
  )
  const [bundleFeedback, setBundleFeedback] = useState<{
    variant: AlertVariant
    title: string
  } | null>(null)
  const [holdingsUploading, setHoldingsUploading] = useState(false)
  const [holdingsResult, setHoldingsResult] = useState<HoldingsResult | null>(
    null,
  )
  const [holdingsFeedback, setHoldingsFeedback] = useState<{
    variant: AlertVariant
    title: string
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bundleFileRef = useRef<HTMLInputElement>(null)
  const holdingsFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void getJson<CsvProfileOption[]>('/api/import/profiles')
      .then((list) => {
        setCsvProfileOptions(list)
        setProfileId((prev) =>
          list.some((p) => p.id === prev) ? prev : list[0]?.id ?? 'auto'
        )
      })
      .catch(() => {})
  }, [])

  async function onPreview() {
    const input = fileRef.current
    const files = Array.from(input?.files ?? [])
    const file = files[0]
    if (!file) {
      setUploadFeedback({ variant: 'error', title: 'Choose a .csv file first.' })
      setPreviewData(null)
      return
    }
    if (files.length > 1) {
      setUploadFeedback({
        variant: 'error',
        title:
          'Preview supports one file at a time. Select one CSV to preview, or import all selected files.',
      })
      setPreviewData(null)
      return
    }
    if (!uploadAccountId) {
      setUploadFeedback({ variant: 'error', title: 'Select an account.' })
      setPreviewData(null)
      return
    }
    setPreviewing(true)
    setUploadFeedback(null)
    setPreviewData(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('accountId', uploadAccountId)
      fd.append('profileId', profileId)
      const r = await postFormData<PreviewResponse>('/api/import/preview', fd)
      setPreviewData(r)
    } catch (e) {
      setUploadFeedback({
        variant: 'error',
        title: e instanceof Error ? e.message : 'Preview failed',
      })
    } finally {
      setPreviewing(false)
    }
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault()
    if (previewData?.previewToken) {
      setUploading(true)
      setUploadFeedback(null)
      try {
        const result = await postJson<UploadResult>('/api/import/commit', {
          previewToken: previewData.previewToken,
        })
        const title = summarizeUploadResult(result)
        setUploadFeedback({
          variant: classifyUploadMessage(title),
          title,
          lines: result.parseErrors?.length
            ? formatParseErrorLines(result.parseErrors)
            : undefined,
        })
        setPreviewData(null)
        const input = fileRef.current
        if (input) input.value = ''
        onCommitted()
      } catch (e) {
        setUploadFeedback({
          variant: 'error',
          title: e instanceof Error ? e.message : 'Import failed',
        })
      } finally {
        setUploading(false)
      }
      return
    }
    const input = fileRef.current
    const files = Array.from(input?.files ?? [])
    if (files.length === 0) {
      setUploadFeedback({
        variant: 'error',
        title: 'Choose at least one statement file first.',
      })
      return
    }
    if (!uploadAccountId) {
      setUploadFeedback({ variant: 'error', title: 'Select an account.' })
      return
    }
    setUploading(true)
    setUploadFeedback(null)
    try {
      const fd = new FormData()
      fd.append('accountId', uploadAccountId)
      if (batchLabel.trim()) fd.append('batchLabel', batchLabel.trim())
      fd.append('profileId', profileId)
      if (files.length === 1) {
        fd.append('file', files[0])
        const result = await postFormData<UploadResult>('/api/import/upload', fd)
        const title = summarizeUploadResult(result)
        setUploadFeedback({
          variant: classifyUploadMessage(title),
          title,
          lines: result.parseErrors?.length
            ? formatParseErrorLines(result.parseErrors)
            : undefined,
        })
      } else {
        files.forEach((file) => fd.append('files', file))
        const out = await postFormData<MultiUploadResponse>('/api/import/upload-many', fd)
        const imported = out.results.filter((r) => !r.skipped).length
        const inserted = out.results.reduce((sum, r) => sum + (r.inserted ?? 0), 0)
        const skipped = out.results.length - imported
        const failedRows = out.results.reduce((sum, r) => sum + (r.rowErrors ?? 0), 0)
        const lines = out.results.slice(0, 6).map((r) => `${r.file}: ${summarizeUploadResult(r)}`)
        const title = `Multi-file import complete — ${inserted} row(s), ${imported} file(s) imported, ${skipped} skipped${failedRows ? `, ${failedRows} row error(s)` : ''}. ${lines.join(' | ')}${out.results.length > 6 ? ' | …' : ''}`
        const parseLines = out.results.flatMap((result) =>
          result.parseErrors?.length
            ? formatParseErrorLines(result.parseErrors).map(
                (line) => `${result.file}: ${line}`,
              )
            : [],
        )
        setUploadFeedback({
          variant:
            failedRows > 0 ? 'warning' : classifyUploadMessage(title),
          title,
          lines: parseLines.length > 0 ? parseLines : undefined,
        })
      }
      if (input) input.value = ''
      onCommitted()
    } catch (e) {
      setUploadFeedback({
        variant: 'error',
        title: e instanceof Error ? e.message : 'Upload failed',
      })
    } finally {
      setUploading(false)
    }
  }

  async function onBundleUpload(e: FormEvent) {
    e.preventDefault()
    const input = bundleFileRef.current
    const files = Array.from(input?.files ?? [])
    if (files.length === 0) {
      setBundleFeedback({
        variant: 'error',
        title: 'Choose at least one Wealthsimple statement CSV first.',
      })
      return
    }
    setBundleUploading(true)
    setBundleFeedback(null)
    setBundleResults(null)
    try {
      const fd = new FormData()
      files.forEach((file) => fd.append('files', file))
      const out = await postFormData<BundleUploadResponse>(
        '/api/import/upload-bundle',
        fd,
      )
      setBundleResults(out.results)
      const filesWithErrors = out.results.filter((r) => r.error).length
      const accountsCreated = out.results.filter((r) => r.accountCreated).length
      const importedTxns = out.results.reduce(
        (sum, r) => sum + r.insertedTransactions,
        0,
      )
      const importedActs = out.results.reduce(
        (sum, r) => sum + r.insertedInvestmentActivities,
        0,
      )
      const dupes = out.results.reduce((sum, r) => sum + r.skippedDuplicates, 0)
      const title = `Bundle import complete — ${out.results.length} file(s), ${accountsCreated} new account(s), ${importedTxns} transaction(s), ${importedActs} investment activity(ies), ${dupes} dup(s) skipped${filesWithErrors ? `, ${filesWithErrors} file error(s)` : ''}.`
      setBundleFeedback({
        variant: filesWithErrors > 0 ? 'warning' : 'success',
        title,
      })
      if (input) input.value = ''
      onCommitted()
      ;(onAccountsChanged ?? onCommitted)()
    } catch (e) {
      setBundleFeedback({
        variant: 'error',
        title: e instanceof Error ? e.message : 'Bundle upload failed',
      })
    } finally {
      setBundleUploading(false)
    }
  }

  async function onHoldingsUpload(e: FormEvent) {
    e.preventDefault()
    const input = holdingsFileRef.current
    const file = input?.files?.[0]
    if (!file) {
      setHoldingsFeedback({
        variant: 'error',
        title: 'Choose a Wealthsimple holdings CSV first.',
      })
      return
    }
    setHoldingsUploading(true)
    setHoldingsFeedback(null)
    setHoldingsResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const result = await postFormData<HoldingsResult>(
        '/api/import/upload-holdings',
        fd,
      )
      setHoldingsResult(result)
      const dateStr = result.statementDate
        ? `as of ${result.statementDate}`
        : 'statement date unknown'
      const counts = `${result.inserted} new, ${result.updated} updated, ${result.skippedUnknownAccount} skipped (unknown account)`
      const errCount = result.errors.length
      const title = `Holdings import complete — ${result.totalRows} row(s) ${dateStr}; ${counts}; ${result.accountsAffected} account(s) touched${errCount ? `, ${errCount} error(s)` : ''}.`
      setHoldingsFeedback({
        variant: errCount > 0 ? 'error' : result.skippedUnknownAccount > 0 ? 'warning' : 'success',
        title,
      })
      if (input) input.value = ''
      onCommitted()
    } catch (e) {
      setHoldingsFeedback({
        variant: 'error',
        title: e instanceof Error ? e.message : 'Holdings upload failed',
      })
    } finally {
      setHoldingsUploading(false)
    }
  }

  async function onRunFolderImport() {
    try {
      setRunningFolderImport(true)
      setUploadFeedback(null)
      const out = await postJson<FolderImportResponse>('/api/import/run', {})
      const imported = out.results.filter((r) => !r.skipped).length
      const skipped = out.results.length - imported
      const lines = out.results.slice(0, 6).map((r) => {
        if (r.skipped) {
          return `${r.file}: skipped (${r.reason})${r.message ? ` — ${r.message}` : ''}`
        }
        return `${r.file}: ${r.inserted ?? 0} rows${r.warning ? ` — ${r.warning}` : ''}`
      })
      const title = lines.length
        ? `Folder import complete — ${imported} imported, ${skipped} skipped. ${lines.join(' | ')}${out.results.length > 6 ? ' | …' : ''}`
        : `No .csv files in upload folder: ${out.uploadDir}`
      setUploadFeedback({
        variant: classifyUploadMessage(title),
        title,
      })
      onCommitted()
    } catch (e) {
      setUploadFeedback({
        variant: 'error',
        title: e instanceof Error ? e.message : 'Import failed',
      })
    } finally {
      setRunningFolderImport(false)
    }
  }

  if (mode === 'bundle') {
    return (
      <form
        className="card uploadCard transactionsPanel"
        onSubmit={onBundleUpload}
      >
        <div className="transactionsPanelHeader">
          <div>
            <h2>Wealthsimple bundle (auto-route)</h2>
            <p className="muted">
              Drop the entire monthly-statement download. Files are routed
              to accounts by the WS account ID in each filename — new
              accounts are created on first sight, corporate-account
              transactions are tagged as business automatically.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setMode('standard')
              setBundleFeedback(null)
              setBundleResults(null)
            }}
          >
            Switch to standard upload
          </Button>
        </div>
        <div className="formGrid transactionsFilterGrid">
          <Label className="filePick">
            Wealthsimple statement files
            <Input
              ref={bundleFileRef}
              type="file"
              accept=".csv,text/csv"
              multiple
              onChange={() => {
                setBundleFeedback(null)
                setBundleResults(null)
              }}
            />
          </Label>
        </div>
        <div className="row transactionsActionRow">
          <Button type="submit" disabled={bundleUploading}>
            {bundleUploading ? 'Importing bundle…' : 'Import bundle'}
          </Button>
        </div>
        {bundleFeedback && (
          <Alert
            className="mt-3"
            variant={bundleFeedback.variant}
            title={bundleFeedback.title}
          />
        )}
        {bundleResults && bundleResults.length > 0 && (
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Transactions</TableHead>
                  <TableHead>Invest activities</TableHead>
                  <TableHead>Skipped dupes</TableHead>
                  <TableHead>Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...bundleResults]
                  .sort((a, b) => {
                    const an = a.accountName ?? 'zzzzz'
                    const bn = b.accountName ?? 'zzzzz'
                    return an === bn ? a.file.localeCompare(b.file) : an.localeCompare(bn)
                  })
                  .map((r) => (
                    <TableRow key={r.file}>
                      <TableCell title={r.file}>{r.file}</TableCell>
                      <TableCell>
                        {r.accountName ?? '—'}
                        {r.accountCreated ? (
                          <span className="muted"> (new)</span>
                        ) : null}
                      </TableCell>
                      <TableCell>{r.insertedTransactions}</TableCell>
                      <TableCell>{r.insertedInvestmentActivities}</TableCell>
                      <TableCell>{r.skippedDuplicates}</TableCell>
                      <TableCell className={r.error ? 'error' : ''}>
                        {r.error
                          ? r.error
                          : r.rowErrors > 0
                            ? `${r.rowErrors} row error(s)`
                            : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        )}
      </form>
    )
  }

  if (mode === 'holdings') {
    return (
      <form
        className="card uploadCard transactionsPanel"
        onSubmit={onHoldingsUpload}
      >
        <div className="transactionsPanelHeader">
          <div>
            <h2>Wealthsimple holdings (positions snapshot)</h2>
            <p className="muted">
              Drop the holdings/positions report exported from Wealthsimple
              (single CSV, all accounts).  The statement date is read from the
              trailing <code>“As of YYYY-MM-DD …”</code> line in the file;
              each holding becomes a <code>HoldingSnapshot</code> row keyed by
              the WS account ID.  Re-uploading the same date updates the
              existing rows.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setMode('standard')
              setHoldingsFeedback(null)
              setHoldingsResult(null)
            }}
          >
            Switch to standard upload
          </Button>
        </div>
        <div className="formGrid transactionsFilterGrid">
          <Label className="filePick">
            Holdings report
            <Input
              ref={holdingsFileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={() => {
                setHoldingsFeedback(null)
                setHoldingsResult(null)
              }}
            />
          </Label>
        </div>
        <div className="row transactionsActionRow">
          <Button type="submit" disabled={holdingsUploading}>
            {holdingsUploading ? 'Importing holdings…' : 'Import holdings'}
          </Button>
        </div>
        {holdingsFeedback && (
          <Alert
            className="mt-3"
            variant={holdingsFeedback.variant}
            title={holdingsFeedback.title}
          />
        )}
        {holdingsResult && (
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>Statement date</TableHead>
                  <TableHead>Total rows</TableHead>
                  <TableHead>Inserted</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Skipped (unknown account)</TableHead>
                  <TableHead>Accounts touched</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>{holdingsResult.statementDate ?? '—'}</TableCell>
                  <TableCell>{holdingsResult.totalRows}</TableCell>
                  <TableCell>{holdingsResult.inserted}</TableCell>
                  <TableCell>{holdingsResult.updated}</TableCell>
                  <TableCell>{holdingsResult.skippedUnknownAccount}</TableCell>
                  <TableCell>{holdingsResult.accountsAffected}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            {holdingsResult.warnings.length > 0 && (
              <ul className="parseErrorList" aria-label="Holdings import warnings">
                {holdingsResult.warnings.slice(0, 8).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>
    )
  }

  return (
    <form className="card uploadCard transactionsPanel" onSubmit={onUpload}>
      <div className="transactionsPanelHeader">
        <div>
          <h2>Upload CSV</h2>
          <p className="muted">
            Pick the account, then drop in CSV, OFX, or QFX files. With{' '}
            <strong>Automatic</strong>, the app detects the column layout from
            CSV files; OFX/QFX files use their embedded statement data.
          </p>
        </div>
        <div className="row">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setMode('bundle')
              setUploadFeedback(null)
              setPreviewData(null)
            }}
          >
            Wealthsimple bundle
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setMode('holdings')
              setUploadFeedback(null)
              setPreviewData(null)
            }}
          >
            Wealthsimple holdings
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void onRunFolderImport()}
            disabled={runningFolderImport}
          >
            {runningFolderImport ? 'Running import…' : 'Run folder import'}
          </Button>
          <span className="transactionsPanelBadge">
            {csvProfileOptions.length || 3} profiles
          </span>
        </div>
      </div>
      {accounts.length === 0 && (
        <p className="error">
          No accounts yet — <Link to="/accounts">create one under Accounts</Link>.
        </p>
      )}
      <div className="formGrid transactionsFilterGrid">
        <Label>
          Account
          <NativeSelect
            value={uploadAccountId}
            onChange={(e) => setUploadAccountId(e.target.value)}
            required
          >
            <NativeSelectOption value="">— select —</NativeSelectOption>
            {accounts.map((a) => (
              <NativeSelectOption key={a.id} value={a.id}>
                {a.name}
                {a.shortCode ? ` (${a.shortCode})` : ''}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        <Label>
          Batch label (optional)
          <Input
            value={batchLabel}
            onChange={(e) => setBatchLabel(e.target.value)}
            placeholder="defaults to YYYY-MM + account code"
          />
        </Label>
        <Label>
          CSV profile
          <NativeSelect value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {csvProfileOptions.length > 0 ? (
              csvProfileOptions.map((p) => (
                <NativeSelectOption key={p.id} value={p.id} title={p.hint}>
                  {p.label}
                  {p.hint ? ` — ${p.hint}` : ''}
                </NativeSelectOption>
              ))
            ) : (
              <Fragment>
                <NativeSelectOption value="auto">Automatic</NativeSelectOption>
                <NativeSelectOption value="generic_simple">generic_simple (ISO dates)</NativeSelectOption>
                <NativeSelectOption value="generic_amex">generic_amex (Amex)</NativeSelectOption>
              </Fragment>
            )}
          </NativeSelect>
        </Label>
        <Label className="filePick">
          Statement files
          <Input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,.ofx,.qfx,.pdf,application/pdf"
            multiple
            onChange={() => {
              setPreviewData(null)
              setUploadFeedback(null)
            }}
          />
        </Label>
      </div>
      <div className="row transactionsActionRow">
        <Button
          type="button"
          variant="secondary"
          disabled={
            uploading ||
            previewing ||
            !uploadAccountId ||
            accounts.length === 0
          }
          onClick={() => void onPreview()}
        >
          {previewing ? 'Previewing…' : 'Preview statement'}
        </Button>
        <Button type="submit" disabled={uploading}>
          {uploading ? 'Importing…' : previewData?.previewToken ? 'Commit preview' : 'Import CSV file(s)'}
        </Button>
      </div>
      {uploadFeedback && (
        <Alert
          className="mt-3"
          variant={uploadFeedback.variant}
          title={uploadFeedback.title}
        >
          {uploadFeedback.lines && uploadFeedback.lines.length > 0 ? (
            <ul
              className="parseErrorList m-0 pl-5"
              aria-label="Rows that failed to parse"
            >
              {uploadFeedback.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      )}
      {previewData && (
        <div className="previewBlock">
          <p className="muted">
            Parser: <strong>{previewData.usedParser}</strong>
            {previewData.headers?.length ? (
              <>
                {' · '}Parsed columns: <code>{previewData.headers.join(', ')}</code>
              </>
            ) : null}
            {' · '}
            Showing up to {previewData.previewRowLimit} data rows (not imported).
          </p>
          {previewData.usedProfileId != null && (
            <p className="muted">
              Profile used: <strong>{previewData.usedProfileId}</strong>
              {previewData.profileInferred ? ' (auto-detected)' : ''}
            </p>
          )}
          <p className="muted">
            Preview contains {previewData.transactions.length} transaction(s),{' '}
            {previewData.investmentActivities.length} investment activit{previewData.investmentActivities.length === 1 ? 'y' : 'ies'}, and{' '}
            {previewData.holdings.length} holding(s). Duplicates detected:{' '}
            {previewData.duplicateCounts.transactions + previewData.duplicateCounts.investmentActivities + previewData.duplicateCounts.holdings}.
          </p>
          {previewData.warnings.length > 0 && (
            <ul className="parseErrorList" aria-label="Statement import warnings">
              {previewData.warnings.slice(0, 8).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Cur</TableHead>
                  <TableHead>Parse note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(previewData.rows ?? []).map((row) => (
                  <TableRow key={row.rowIndex}>
                    <TableCell>{row.rowIndex}</TableCell>
                    <TableCell>{row.ok ? 'OK' : 'Error'}</TableCell>
                    <TableCell>{row.ok ? row.mapped.date : '—'}</TableCell>
                    <TableCell>{row.ok ? row.mapped.merchantClean : '—'}</TableCell>
                    <TableCell>{row.ok ? String(row.mapped.amount) : '—'}</TableCell>
                    <TableCell>{row.ok ? row.mapped.currency : '—'}</TableCell>
                    <TableCell className={row.ok ? '' : 'error'}>
                      {row.ok ? '—' : row.error}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </form>
  )
}
