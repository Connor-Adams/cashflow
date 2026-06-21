import { useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { GmailSection } from '@/pages/settings/sections/GmailSection'
import { GmailScanHistory } from '@/components/receipts/GmailScanHistory'
import { MatchUnlinkedButton } from '@/components/receipts/MatchUnlinkedButton'
import { CategorizeItemsButton } from '@/components/receipts/CategorizeItemsButton'
import { ReceiptsList, type ReceiptGroup } from '@/components/receipts/ReceiptsList'
import { AmazonPage } from '@/pages/AmazonPage'

const GROUPS: { value: ReceiptGroup; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'gmail', label: 'Gmail' },
  { value: 'amazon', label: 'Amazon' },
  { value: 'other', label: 'Other' },
]

function resolveGroup(params: URLSearchParams): ReceiptGroup {
  if (params.get('vendor') === 'amazon') return 'amazon'
  const g = params.get('group')
  if (g === 'gmail' || g === 'amazon' || g === 'other') return g
  return 'all'
}

export function ReceiptsPage() {
  const [params, setParams] = useSearchParams()
  const group = resolveGroup(params)
  const sourcesRef = useRef<HTMLDivElement>(null)

  function selectGroup(next: ReceiptGroup) {
    const p = new URLSearchParams()
    if (next !== 'all') p.set('group', next)
    setParams(p, { replace: true })
  }

  return (
    <main className="p-6 max-w-5xl mx-auto flex flex-col gap-4">
      <PageHeader
        title="Receipts"
        description="Emailed receipts and imported orders, and how they match your card transactions."
      />

      <div ref={sourcesRef}>
        <GmailSection />
      </div>
      <GmailScanHistory />

      <div className="flex flex-wrap items-center gap-3">
        <MatchUnlinkedButton />
        <CategorizeItemsButton />
      </div>

      <nav className="flex gap-2 border-b border-border" aria-label="Filter receipts by source">
        {GROUPS.map((g) => (
          <Button
            key={g.value}
            type="button"
            variant="ghost"
            onClick={() => selectGroup(g.value)}
            aria-pressed={group === g.value}
            className={
              group === g.value
                ? 'px-3 py-2 border-b-2 border-primary font-semibold rounded-none'
                : 'px-3 py-2 border-b-2 border-transparent text-muted-foreground rounded-none'
            }
          >
            {g.label}
          </Button>
        ))}
      </nav>

      {group === 'amazon' ? (
        <AmazonPage embedded />
      ) : (
        <ReceiptsList
          group={group}
          onUploadClick={() =>
            sourcesRef.current?.scrollIntoView({ behavior: 'smooth' })
          }
          onClearGroup={() => selectGroup('all')}
        />
      )}
    </main>
  )
}
