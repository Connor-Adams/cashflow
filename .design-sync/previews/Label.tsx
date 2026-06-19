import { Label, Input, NativeSelect, NativeSelectOption } from '@cashflow/ui'

export function FormFields() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 320 }}>
      <Label>
        Merchant
        <Input defaultValue="Hydro Québec" />
      </Label>
      <Label>
        Category
        <NativeSelect defaultValue="utilities">
          <NativeSelectOption value="utilities">Utilities</NativeSelectOption>
          <NativeSelectOption value="groceries">Groceries</NativeSelectOption>
          <NativeSelectOption value="transport">Transport</NativeSelectOption>
        </NativeSelect>
      </Label>
    </div>
  )
}
