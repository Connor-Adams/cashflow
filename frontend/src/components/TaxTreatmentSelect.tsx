import { TREATMENT_LABELS, type TaxTreatment } from '../lib/taxTreatment'

interface TaxTreatmentSelectProps {
  value: TaxTreatment | null
  options: TaxTreatment[]
  onChange: (next: TaxTreatment) => void
  placeholder?: string
  'aria-label'?: string
}

export function TaxTreatmentSelect({
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  'aria-label': ariaLabel,
}: TaxTreatmentSelectProps) {
  return (
    <select
      aria-label={ariaLabel}
      className="text-sm"
      value={value ?? ''}
      onChange={(e) => {
        const next = e.target.value
        if (next) onChange(next as TaxTreatment)
      }}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((t) => (
        <option key={t} value={t}>
          {TREATMENT_LABELS[t]}
        </option>
      ))}
    </select>
  )
}
