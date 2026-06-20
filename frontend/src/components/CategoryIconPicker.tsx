import { CATEGORY_ICON_NAMES, type CategoryIconName } from '@cashflow/shared'
import { Button } from '@connor-adams/designsystem'
import { CATEGORY_ICON_COMPONENTS } from './CategoryIcon'
import { cn } from '@/lib/utils'

type Props = {
  value: CategoryIconName | null
  onSelect: (next: CategoryIconName | null) => void
}

const CELL_BASE =
  'flex items-center justify-center h-12 rounded-md border border-border bg-transparent cursor-pointer hover:bg-accent/10'
const CELL_ACTIVE = 'border-accent bg-accent/15'

export function CategoryIconPicker({ value, onSelect }: Props) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-1 max-h-[400px] overflow-y-auto">
      <Button
        type="button"
        variant="ghost"
        aria-pressed={value === null}
        aria-label="None"
        onClick={() => onSelect(null)}
        className={cn(CELL_BASE, value === null && CELL_ACTIVE)}
        title="None"
      >
        <span className="text-[11px]">None</span>
      </Button>
      {CATEGORY_ICON_NAMES.map((name) => {
        const Icon = CATEGORY_ICON_COMPONENTS[name]
        const active = value === name
        return (
          <Button
            key={name}
            type="button"
            variant="ghost"
            aria-pressed={active}
            aria-label={name}
            onClick={() => onSelect(name)}
            className={cn(CELL_BASE, active && CELL_ACTIVE)}
            title={name}
          >
            <Icon size={20} />
          </Button>
        )
      })}
    </div>
  )
}
