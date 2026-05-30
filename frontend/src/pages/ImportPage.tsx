import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { ImportModal } from '../components/import/ImportModal'
import { ImportHistoryTable } from '../components/import/ImportHistoryTable'
import { getJson } from '../lib/api'
import type { Account } from '../types/api'

/**
 * `/import` — the ingestion surface. Single-column stack:
 *   <PageHeader>+"Import" button → <ImportHistoryTable>
 *
 * Clicking "Import" opens `ImportModal`, which hosts the drop-zone + side
 * pane upload UI for every file mode (PDF bundle, WS bundle, holdings CSV,
 * single statement). Accounts are loaded here so the modal can target a
 * specific account in standard mode.
 */
export function ImportPage() {
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountsError, setAccountsError] = useState(false)
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)

  const loadAccounts = useCallback(() => {
    setAccountsError(false)
    void getJson<Account[]>('/api/accounts')
      .then(setAccounts)
      .catch(() => setAccountsError(true))
  }, [])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  return (
    <div className="page">
      <PageHeader
        title="Import"
        description="Drop CSVs, OFX exports, Wealthsimple bundles, or PDF bundles (RBC, CIBC, Questrade)."
        actions={<Button onClick={() => setModalOpen(true)}>Import statements</Button>}
      />
      {accountsError && (
        <Alert
          variant="error"
          title="Couldn't load accounts."
          action={<Button size="sm" variant="outline" onClick={loadAccounts}>Try again</Button>}
          className="mb-4"
        />
      )}
      <ImportModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        accounts={accounts}
        onCommitted={() => setHistoryRefreshKey((k) => k + 1)}
        onAccountsChanged={() => {
          loadAccounts()
          setHistoryRefreshKey((k) => k + 1)
        }}
      />
      <ImportHistoryTable
        refreshKey={historyRefreshKey}
        onRowClick={(row) =>
          // #231: navigate by id when present (preferred — drives the /api/import/batches/:id
          // detail endpoint). Fall back to the legacy label-shaped URL for rows that
          // somehow lack an id (shouldn't happen in practice; defensive).
          navigate(
            row.id != null
              ? `/import/${row.id}`
              : `/import/${encodeURIComponent(row.batchLabel)}`,
          )
        }
      />
    </div>
  )
}
