import { NativeSelect, NativeSelectOption } from '@cashflow/ui'

function Options() {
  return (
    <>
      <NativeSelectOption value="groceries">Groceries</NativeSelectOption>
      <NativeSelectOption value="dining">Dining</NativeSelectOption>
      <NativeSelectOption value="transport">Transport</NativeSelectOption>
      <NativeSelectOption value="utilities">Utilities</NativeSelectOption>
    </>
  )
}

export function Default() {
  return (
    <NativeSelect defaultValue="dining">
      <Options />
    </NativeSelect>
  )
}

export function Sizes() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <NativeSelect size="default" defaultValue="groceries"><Options /></NativeSelect>
      <NativeSelect size="sm" defaultValue="transport"><Options /></NativeSelect>
    </div>
  )
}
