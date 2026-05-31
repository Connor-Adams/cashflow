import { useCallback, useEffect, useState } from 'react'
import { DollarSign, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useConfirm } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import { LogIncomeModal } from '@/components/income/LogIncomeModal'

type IncomeEntry = {
  id: number
  occurredOn: string
  source: string
  grossAmountCents: string
  taxWithheldCents: string | null
  netAmountCents: string
  currency: string
  categoryId: number | null
  notes: string | null
  accountId: number | null
  linkedTransactionId: number | null
}

type IncomeListResponse = { data: IncomeEntry[] }

const SOURCE_LABELS: Record<string, string> = {
  paycheck: 'Paycheck',
  invoice: 'Invoice',
  cash: 'Cash',
  gift: 'Gift',
  refund: 'Refund',
  other: 'Other',
}

export function IncomePage() {
  const { showToast } = useToast()
  const confirm = useConfirm()
  const [entries, setEntries] = useState<IncomeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await getJson<IncomeListResponse>('/api/income')
      setEntries(resp.data)
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : 'Failed to load income entries',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  async function deleteEntry(entry: IncomeEntry) {
    const ok = await confirm({
      title: 'Delete income entry?',
      description: `This will remove the entry for ${entry.occurredOn}.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/income/${entry.id}`)
      await load()
      showToast({ title: 'Entry deleted', variant: 'success' })
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : 'Could not delete entry',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Income"
        description="Log paychecks, invoices, cash, and other income. Entries can optionally link to a transaction."
        actions={
          <Button onClick={() => setModalOpen(true)}>
            <DollarSign aria-hidden="true" /> Log income
          </Button>
        }
      />

      <Card className="p-0 overflow-x-auto">
        <Table className="table">
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Gross</TableHead>
              <TableHead>Tax withheld</TableHead>
              <TableHead>Net</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead aria-label="actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center muted py-6">Loading…</TableCell>
              </TableRow>
            ) : entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <EmptyState
                    title="No income logged yet."
                    description="Log your first income entry."
                    actions={
                      <Button onClick={() => setModalOpen(true)}>Log income</Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.occurredOn}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                      {SOURCE_LABELS[entry.source] ?? entry.source}
                    </span>
                  </TableCell>
                  <TableCell>
                    {formatMoney(Number(entry.grossAmountCents) / 100, entry.currency)}
                  </TableCell>
                  <TableCell>
                    {entry.taxWithheldCents
                      ? formatMoney(Number(entry.taxWithheldCents) / 100, entry.currency)
                      : <span className="muted">—</span>}
                  </TableCell>
                  <TableCell>
                    {formatMoney(Number(entry.netAmountCents) / 100, entry.currency)}
                  </TableCell>
                  <TableCell>
                    {entry.notes ? (
                      <span className="text-sm">{entry.notes}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => void deleteEntry(entry)}
                    >
                      <Trash2 aria-hidden="true" /> Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {modalOpen && (
        <LogIncomeModal
          onClose={() => setModalOpen(false)}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
