import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { UploadCard } from '../components/import/UploadCard'
import { ImportHistoryTable } from '../components/import/ImportHistoryTable'
import { getJson } from '../lib/api'
import type { Account } from '../types/api'

/**
 * `/import` — the ingestion surface. Single-column stack:
 *   <PageHeader> → <UploadCard> → <ImportHistoryTable>
 *
 * The accounts list is fetched here (rather than inside UploadCard) so a
 * successful Wealthsimple bundle import can refetch it; bundle imports can
 * create new accounts as a side effect.
 *
 * `historyRefreshKey` is bumped after every successful upload / commit /
 * folder-import so the embedded `ImportHistoryTable` knows to re-fetch.
 */
export function ImportPage() {
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)

  const loadAccounts = useCallback(() => {
    void getJson<Account[]>('/api/accounts')
      .then(setAccounts)
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  return (
    <div className="page">
      <PageHeader
        title="Import"
        description="CSVs, OFX exports, or Wealthsimple bundles."
      />
      <UploadCard
        accounts={accounts}
        onCommitted={() => setHistoryRefreshKey((k) => k + 1)}
        onAccountsChanged={() => {
          loadAccounts()
          setHistoryRefreshKey((k) => k + 1)
        }}
      />
      <ImportHistoryTable
        refreshKey={historyRefreshKey}
        onRowClick={(batchLabel) =>
          navigate(`/import/${encodeURIComponent(batchLabel)}`)
        }
      />
    </div>
  )
}
