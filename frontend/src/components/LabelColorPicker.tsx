import { Icon } from '@connor-adams/designsystem'
import { LABEL_COLOR_PALETTE } from '../lib/labelColors'

type Props = {
  /** Currently selected color (`#RRGGBB`) or `null` for "no color". */
  value: string | null
  /** Called with the new color, or `null` when the "none" swatch is chosen. */
  onChange: (color: string | null) => void
  disabled?: boolean
}

/**
 * Fixed-palette color swatch picker for labels (issue #794). Palette-only by
 * design — no free-form hex/color-wheel input. Renders the ~8 palette swatches
 * plus a "no color" (neutral) option; the selected swatch shows a check. The
 * selection is reflected via `aria-pressed` for assistive tech and tests.
 */
export function LabelColorPicker({ value, onChange, disabled }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Color">
      <button
        type="button"
        aria-label="No color"
        aria-pressed={value == null}
        disabled={disabled}
        onClick={() => onChange(null)}
        className="flex size-6 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
      >
        {value == null ? <Icon name="check" className="size-3.5" aria-hidden="true" /> : null}
      </button>
      {LABEL_COLOR_PALETTE.map((color) => {
        const selected = value?.toLowerCase() === color.toLowerCase()
        return (
          <button
            key={color}
            type="button"
            aria-label={`Color ${color}`}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(color)}
            style={{ backgroundColor: color }}
            className="flex size-6 items-center justify-center rounded-full border border-black/10"
          >
            {selected ? (
              <Icon name="check" className="size-3.5 text-white" aria-hidden="true" />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
