import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tabs, TabPanel } from '@cashflow/ui'
import { ItemsBrowse } from '@/components/items/ItemsBrowse'
import { ItemsSearch } from '@/components/items/ItemsSearch'
import { ItemsFilterStrip } from '@/components/items/ItemsFilterStrip'
import { ItemDetailDrawer } from '@/components/items/ItemDetailDrawer'
import { AnalyzeTab } from '@/components/items/AnalyzeTab'
import type { ItemsFilters } from '@/hooks/useItems'
import type { ItemRow } from '@cashflow/shared'

type TabKey = 'browse' | 'analyze' | 'search'

const TAB_ITEMS = [
  { value: 'browse', label: 'Browse' },
  { value: 'analyze', label: 'Analyze' },
  { value: 'search', label: 'Search' },
]

function parseFilters(params: URLSearchParams): ItemsFilters {
  const get = (k: string): string | undefined => {
    const v = params.get(k)
    return v && v.length > 0 ? v : undefined
  }
  const numOf = (k: string): number | undefined => {
    const v = get(k)
    if (v == null) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const bu = get('businessUse')
  return {
    category: get('category'),
    businessUse: bu === 'true' || bu === 'false' ? bu : undefined,
    from: get('from'),
    to: get('to'),
    vendor: get('vendor'),
    minPrice: numOf('minPrice'),
    maxPrice: numOf('maxPrice'),
    q: get('q'),
  }
}

function writeFilters(params: URLSearchParams, next: ItemsFilters): URLSearchParams {
  const p = new URLSearchParams(params)
  const keys: (keyof ItemsFilters)[] = [
    'category',
    'businessUse',
    'from',
    'to',
    'vendor',
    'minPrice',
    'maxPrice',
    'q',
  ]
  for (const k of keys) {
    const v = next[k]
    if (v == null || v === '') p.delete(k)
    else p.set(k, String(v))
  }
  return p
}

export function ItemsPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as TabKey | null) ?? 'browse'
  const itemIdRaw = params.get('item')
  const itemId = itemIdRaw && /^\d+$/.test(itemIdRaw) ? Number(itemIdRaw) : null
  const filters = useMemo(() => parseFilters(params), [params])
  const [openItemRow, setOpenItemRow] = useState<ItemRow | null>(null)

  const setTab = (v: string) => {
    const p = new URLSearchParams(params)
    p.set('tab', v)
    setParams(p, { replace: true })
  }

  const setFilters = useCallback(
    (next: ItemsFilters) => {
      setParams(writeFilters(params, next), { replace: true })
    },
    [params, setParams],
  )

  const openItem = (id: number, row: ItemRow) => {
    setOpenItemRow(row)
    const p = new URLSearchParams(params)
    p.set('item', String(id))
    setParams(p, { replace: true })
  }

  const closeItem = () => {
    const p = new URLSearchParams(params)
    p.delete('item')
    setParams(p, { replace: true })
  }

  const onPatched = (patch: Partial<ItemRow>) => {
    if (openItemRow) setOpenItemRow({ ...openItemRow, ...patch })
  }

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <h1 className="text-xl font-semibold">Items</h1>
        <Tabs items={TAB_ITEMS} value={tab} onValueChange={setTab} />
        {(tab === 'browse' || tab === 'search') && (
          <ItemsFilterStrip filters={filters} onChange={setFilters} />
        )}
      </header>

      <TabPanel value="browse" active={tab}>
        <ItemsBrowse filters={filters} onOpenItem={openItem} />
      </TabPanel>
      <TabPanel value="analyze" active={tab}>
        <AnalyzeTab />
      </TabPanel>
      <TabPanel value="search" active={tab}>
        <ItemsSearch filters={filters} onChangeFilters={setFilters} onOpenItem={openItem} />
      </TabPanel>

      <ItemDetailDrawer
        itemId={itemId}
        item={openItemRow}
        onClose={closeItem}
        onPatched={onPatched}
      />
    </div>
  )
}
