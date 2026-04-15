import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  getJson,
  patchJson,
  postFormData,
  postJson,
} from '../lib/api'
import { formatParseErrorLines } from '../lib/formatParseErrors'
import type { Account, Paginated, Transaction } from '../types/api'

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
}

type FolderImportResponse = {
  results: UploadResult[]
  uploadDir: string
}

type ImportHistoryRow = {
  id: number
  fileName: string
  batchLabel: string
  status: string
  rowCount: number | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
}

export function TransactionsPage() {
  const [page, setPage] = useState(1)
  const [reviewOnly, setReviewOnly] = useState(false)
  const [currency, setCurrency] = useState('')
  const [batchFilter, setBatchFilter] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [bulkCat, setBulkCat] = useState('')
  const [bulkBiz, setBulkBiz] = useState('')
  const [bulkSplit, setBulkSplit] = useState('')
  const [bulkPctMe, setBulkPctMe] = useState('')
  const [bulkPctPartner, setBulkPctPartner] = useState('')
  const [bulkMarkReviewed, setBulkMarkReviewed] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  const [importHistory, setImportHistory] = useState<ImportHistoryRow[]>([])
  const [res, setRes] = useState<Paginated<Transaction> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [uploadAccountId, setUploadAccountId] = useState('')
  const [batchLabel, setBatchLabel] = useState('')
  const [profileId, setProfileId] = useState('generic_simple')
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const [uploadParseLines, setUploadParseLines] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void getJson<Account[]>('/api/accounts')
      .then(setAccounts)
      .catch(() => {})
  }, [])

  const refreshImportHistory = useCallback(() => {
    void getJson<ImportHistoryRow[]>('/api/import/history')
      .then(setImportHistory)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshImportHistory()
  }, [refreshImportHistory])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: '25',
      })
      if (reviewOnly) qs.set('reviewFlag', 'true')
      if (currency) qs.set('currency', currency)
      if (batchFilter.trim()) qs.set('importBatch', batchFilter.trim())
      const data = await getJson<Paginated<Transaction>>(
        `/api/transactions?${qs.toString()}`
      )
      setRes(data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [page, reviewOnly, currency, batchFilter])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [page])

  async function saveRow(id: number, patch: Record<string, unknown>) {
    await patchJson<Transaction>(`/api/transactions/${id}`, patch)
    await load()
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  function selectAllOnPage() {
    const rows = res?.data ?? []
    const ids = rows.map((t) => t.id)
    setSelectedIds((prev) => {
      const allOnPage = ids.length > 0 && ids.every((id) => prev.has(id))
      if (allOnPage) return new Set()
      return new Set(ids)
    })
  }

  function buildBulkPatch(): Record<string, unknown> | null {
    const patch: Record<string, unknown> = {}
    if (bulkCat.trim()) patch.categoryOverride = bulkCat.trim()
    if (bulkBiz === 'true' || bulkBiz === 'false')
      patch.businessOverride = bulkBiz === 'true'
    if (bulkSplit === 'me' || bulkSplit === 'partner' || bulkSplit === 'shared')
      patch.splitOverride = bulkSplit
    if (bulkPctMe.trim()) {
      const n = Number(bulkPctMe)
      if (!Number.isFinite(n)) return null
      patch.pctMeOverride = n
    }
    if (bulkPctPartner.trim()) {
      const n = Number(bulkPctPartner)
      if (!Number.isFinite(n)) return null
      patch.pctPartnerOverride = n
    }
    if (bulkMarkReviewed) patch.reviewFlag = false
    return Object.keys(patch).length ? patch : null
  }

  async function applyBulk() {
    const patch = buildBulkPatch()
    if (!patch || selectedIds.size === 0) return
    setBulkApplying(true)
    setErr(null)
    try {
      await postJson<{ updated: number }>('/api/transactions/bulk-patch', {
        ids: [...selectedIds],
        patch,
      })
      setBulkCat('')
      setBulkBiz('')
      setBulkSplit('')
      setBulkPctMe('')
      setBulkPctPartner('')
      setBulkMarkReviewed(false)
      setSelectedIds(new Set())
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Bulk update failed')
    } finally {
      setBulkApplying(false)
    }
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault()
    const input = fileRef.current
    const file = input?.files?.[0]
    if (!file) {
      setUploadMsg('Choose a .csv file first.')
      return
    }
    if (!uploadAccountId) {
      setUploadMsg('Select an account.')
      return
    }
    setUploading(true)
    setUploadMsg(null)
    setUploadParseLines([])
    setErr(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('accountId', uploadAccountId)
      if (batchLabel.trim()) fd.append('batchLabel', batchLabel.trim())
      fd.append('profileId', profileId)
      const result = await postFormData<UploadResult>('/api/import/upload', fd)
      if (result.skipped) {
        setUploadParseLines([])
        setUploadMsg(
          [
            `Skipped (${result.reason ?? 'unknown'}): ${result.file}`,
            result.message,
          ]
            .filter(Boolean)
            .join(' — ')
        )
      } else {
        const parts = [
          `Imported ${result.inserted ?? 0} row(s) · batch “${result.batchLabel ?? ''}” · dupes skipped: ${result.skippedDuplicates ?? 0}`,
          (result.rowErrors ?? 0) > 0
            ? `${result.rowErrors} row(s) could not be parsed (wrong columns or date format?)`
            : '',
          result.warning,
        ].filter(Boolean)
        setUploadMsg(parts.join(' — '))
        setUploadParseLines(
          result.parseErrors?.length
            ? formatParseErrorLines(result.parseErrors)
            : []
        )
      }
      if (input) input.value = ''
      await load()
      refreshImportHistory()
    } catch (e) {
      setUploadMsg(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="page">
      <h1>Transactions</h1>

      <form className="card uploadCard" onSubmit={onUpload}>
        <h2>Upload CSV</h2>
        <p className="muted">
          Pick the account this statement belongs to, then choose your bank’s
          CSV export. Rows are parsed with the selected profile (same as folder
          import).
        </p>
        {accounts.length === 0 && (
          <p className="error">
            No accounts yet —{' '}
            <Link to="/accounts">create one under Accounts</Link>.
          </p>
        )}
        <div className="formGrid">
          <label>
            Account
            <select
              value={uploadAccountId}
              onChange={(e) => setUploadAccountId(e.target.value)}
              required
            >
              <option value="">— select —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.shortCode ? ` (${a.shortCode})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Batch label (optional)
            <input
              value={batchLabel}
              onChange={(e) => setBatchLabel(e.target.value)}
              placeholder="defaults to YYYY-MM + account code"
            />
          </label>
          <label>
            CSV profile
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="generic_simple">generic_simple (ISO dates)</option>
              <option value="generic_amex">Amex / generic_amex</option>
              <option value="amex">amex (same as Amex)</option>
            </select>
          </label>
          <label className="filePick">
            File
            <input ref={fileRef} type="file" accept=".csv,text/csv" />
          </label>
        </div>
        <button type="submit" disabled={uploading}>
          {uploading ? 'Importing…' : 'Import CSV'}
        </button>
        {uploadMsg && (
          <p
            className={
              uploadMsg.includes('No rows') ||
              uploadMsg.includes('duplicate') ||
              uploadMsg.includes('Skipped')
                ? 'uploadMsg warn'
                : 'uploadMsg'
            }
          >
            {uploadMsg}
          </p>
        )}
        {uploadParseLines.length > 0 && (
          <ul className="parseErrorList" aria-label="Rows that failed to parse">
            {uploadParseLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </form>

      <section className="card" aria-labelledby="import-history-heading">
        <h2 id="import-history-heading">Recent imports</h2>
        <p className="muted">
          Last 50 runs (upload or folder). Use <strong>Filter by batch</strong> to
          narrow the table to one import batch.
        </p>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>File</th>
                <th>Batch</th>
                <th>Status</th>
                <th>Rows</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {importHistory.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted pad">
                    No import history yet.
                  </td>
                </tr>
              ) : (
                importHistory.map((h) => (
                  <tr key={h.id}>
                    <td>{h.startedAt.slice(0, 19).replace('T', ' ')}</td>
                    <td title={h.fileName}>{h.fileName}</td>
                    <td>{h.batchLabel}</td>
                    <td>
                      {h.status}
                      {h.errorMessage ? (
                        <span className="muted" title={h.errorMessage}>
                          {' '}
                          ({h.errorMessage.slice(0, 40)}
                          {h.errorMessage.length > 40 ? '…' : ''})
                        </span>
                      ) : null}
                    </td>
                    <td>{h.rowCount ?? '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => {
                          setPage(1)
                          setBatchFilter(h.batchLabel)
                        }}
                      >
                        Filter by batch
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={reviewOnly}
            onChange={(e) => {
              setPage(1)
              setReviewOnly(e.target.checked)
            }}
          />{' '}
          Review only
        </label>
        <label>
          Currency{' '}
          <input
            value={currency}
            onChange={(e) => {
              setPage(1)
              setCurrency(e.target.value.toUpperCase())
            }}
            placeholder="e.g. CAD"
            maxLength={3}
            style={{ width: 80 }}
          />
        </label>
        <label>
          Import batch{' '}
          <input
            value={batchFilter}
            onChange={(e) => {
              setPage(1)
              setBatchFilter(e.target.value)
            }}
            placeholder="exact batch label"
            style={{ minWidth: 180 }}
          />
        </label>
        {batchFilter.trim() ? (
          <button
            type="button"
            onClick={() => {
              setPage(1)
              setBatchFilter('')
            }}
          >
            Clear batch filter
          </button>
        ) : null}
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              setErr(null)
              setUploadMsg(null)
              const out = await postJson<FolderImportResponse>(
                '/api/import/run',
                {}
              )
              const lines = out.results.map((r) => {
                if (r.skipped) {
                  return `${r.file}: skipped (${r.reason})${r.message ? ` — ${r.message}` : ''}`
                }
                return `${r.file}: ${r.inserted ?? 0} rows${r.warning ? ` — ${r.warning}` : ''}`
              })
              setUploadMsg(
                lines.length
                  ? lines.join(' | ')
                  : `No .csv files in upload folder: ${out.uploadDir}`
              )
              await load()
              refreshImportHistory()
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'Import failed')
            }
          }}
        >
          Run import
        </button>
      </div>
      {err && <span className="error">{err}</span>}
      {selectedIds.size > 0 && (
        <div className="card bulkBar">
          <strong>{selectedIds.size} selected</strong>
          <label>
            Category
            <input
              value={bulkCat}
              onChange={(e) => setBulkCat(e.target.value)}
              placeholder="override"
            />
          </label>
          <label>
            Business
            <select
              value={bulkBiz}
              onChange={(e) => setBulkBiz(e.target.value)}
            >
              <option value="">(no change)</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
          <label>
            Split
            <select
              value={bulkSplit}
              onChange={(e) => setBulkSplit(e.target.value)}
            >
              <option value="">(no change)</option>
              <option value="me">me</option>
              <option value="partner">partner</option>
              <option value="shared">shared</option>
            </select>
          </label>
          <label>
            % me
            <input
              value={bulkPctMe}
              onChange={(e) => setBulkPctMe(e.target.value)}
              style={{ width: 64 }}
              placeholder="0.5"
            />
          </label>
          <label>
            % ptn
            <input
              value={bulkPctPartner}
              onChange={(e) => setBulkPctPartner(e.target.value)}
              style={{ width: 64 }}
              placeholder="0.5"
            />
          </label>
          <label className="checkRow">
            <input
              type="checkbox"
              checked={bulkMarkReviewed}
              onChange={(e) => setBulkMarkReviewed(e.target.checked)}
            />{' '}
            Mark reviewed
          </label>
          <button
            type="button"
            disabled={
              bulkApplying || !buildBulkPatch() || selectedIds.size === 0
            }
            onClick={() => void applyBulk()}
          >
            {bulkApplying ? 'Applying…' : 'Apply to selected'}
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}
      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th className="narrowCol">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={
                    (res?.data.length ?? 0) > 0 &&
                    (res?.data.every((t) => selectedIds.has(t.id)) ?? false)
                  }
                  ref={(el) => {
                    if (el) {
                      const some =
                        (res?.data.some((t) => selectedIds.has(t.id)) ??
                          false) &&
                        !(res?.data.every((t) => selectedIds.has(t.id)) ?? false)
                      el.indeterminate = some
                    }
                  }}
                  onChange={() => selectAllOnPage()}
                />
              </th>
              <th>Date</th>
              <th>Merchant</th>
              <th>Amount</th>
              <th>Cur</th>
              <th>Category</th>
              <th>Business</th>
              <th>Split</th>
              <th>% me</th>
              <th>% ptn</th>
              <th>Review</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={12} className="muted pad">
                  Loading…
                </td>
              </tr>
            ) : !res?.data.length ? (
              <tr>
                <td colSpan={12} className="emptyStateCell">
                  <p>No transactions yet — or none match your filters.</p>
                  <p className="muted">
                    Upload a CSV above (pick an account first), or use <strong>Run import</strong> if you
                    placed files in the configured upload folder. Create accounts under{' '}
                    <Link to="/accounts">Accounts</Link> if needed.
                  </p>
                </td>
              </tr>
            ) : (
              res.data.map((t) => (
                <TransactionRow
                  key={t.id}
                  t={t}
                  selected={selectedIds.has(t.id)}
                  onToggleSelected={() => toggleSelected(t.id)}
                  onSave={saveRow}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </button>
        <span>
          Page {page} / {res ? Math.max(1, Math.ceil(res.total / res.pageSize)) : 1}
        </span>
        <button
          type="button"
          disabled={!res || page * res.pageSize >= res.total}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  )
}

function TransactionRow({
  t,
  selected,
  onToggleSelected,
  onSave,
}: {
  t: Transaction
  selected: boolean
  onToggleSelected: () => void
  onSave: (id: number, patch: Record<string, unknown>) => Promise<void>
}) {
  const [cat, setCat] = useState(t.categoryOverride ?? '')
  const [biz, setBiz] = useState<string>(
    t.businessOverride === null || t.businessOverride === undefined
      ? ''
      : t.businessOverride
        ? 'true'
        : 'false'
  )
  const [split, setSplit] = useState(t.splitOverride ?? '')
  const [pctMe, setPctMe] = useState(
    t.pctMeOverride != null ? String(t.pctMeOverride) : ''
  )
  const [pctPartner, setPctPartner] = useState(
    t.pctPartnerOverride != null ? String(t.pctPartnerOverride) : ''
  )

  useEffect(() => {
    setCat(t.categoryOverride ?? '')
    setBiz(
      t.businessOverride === null || t.businessOverride === undefined
        ? ''
        : t.businessOverride
          ? 'true'
          : 'false'
    )
    setSplit(t.splitOverride ?? '')
    setPctMe(t.pctMeOverride != null ? String(t.pctMeOverride) : '')
    setPctPartner(
      t.pctPartnerOverride != null ? String(t.pctPartnerOverride) : ''
    )
  }, [t])

  return (
    <tr>
      <td className="narrowCol">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={`Select transaction ${t.id}`}
        />
      </td>
      <td>{t.date}</td>
      <td title={t.merchantRaw}>{t.merchantClean}</td>
      <td>{t.amount}</td>
      <td>{t.currency}</td>
      <td>
        <input
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          placeholder={t.finalCategory ?? ''}
        />
      </td>
      <td>
        <select
          value={biz}
          onChange={(e) => setBiz(e.target.value)}
        >
          <option value="">(auto)</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </td>
      <td>
        <select value={split} onChange={(e) => setSplit(e.target.value)}>
          <option value="">(auto)</option>
          <option value="me">me</option>
          <option value="partner">partner</option>
          <option value="shared">shared</option>
        </select>
      </td>
      <td>
        <input
          value={pctMe}
          onChange={(e) => setPctMe(e.target.value)}
          style={{ width: 56 }}
          placeholder="0.5"
        />
      </td>
      <td>
        <input
          value={pctPartner}
          onChange={(e) => setPctPartner(e.target.value)}
          style={{ width: 56 }}
          placeholder="0.5"
        />
      </td>
      <td>{t.reviewFlag ? 'yes' : ''}</td>
      <td>
        <button
          type="button"
          onClick={() =>
            void onSave(t.id, {
              categoryOverride: cat || null,
              businessOverride:
                biz === '' ? null : biz === 'true',
              splitOverride: split || null,
              pctMeOverride: pctMe === '' ? null : Number(pctMe),
              pctPartnerOverride:
                pctPartner === '' ? null : Number(pctPartner),
              reviewFlag: false,
            })
          }
        >
          Save
        </button>
      </td>
    </tr>
  )
}
