import { TREATMENT_LABELS, type TaxTreatment } from '../lib/taxTreatment';

interface TaxTreatmentSelectProps {
  value: TaxTreatment | null;
  options: TaxTreatment[];
  onChange: (next: TaxTreatment | null) => void;
  /** When set, the empty option is selectable with this label and selecting it fires onChange(null). */
  emptyLabel?: string;
  /** Disabled placeholder text when emptyLabel is not provided. */
  placeholder?: string;
  'aria-label'?: string;
}

export function TaxTreatmentSelect({
  value,
  options,
  onChange,
  emptyLabel,
  placeholder = 'Choose…',
  'aria-label': ariaLabel,
}: TaxTreatmentSelectProps) {
  return (
    <select
      aria-label={ariaLabel}
      className="text-sm"
      value={value ?? ''}
      onChange={(e) => {
        const next = e.target.value;
        onChange(next === '' ? null : (next as TaxTreatment));
      }}
    >
      <option value="" disabled={emptyLabel === undefined}>
        {emptyLabel ?? placeholder}
      </option>
      {options.map((t) => (
        <option key={t} value={t}>
          {TREATMENT_LABELS[t]}
        </option>
      ))}
    </select>
  );
}
