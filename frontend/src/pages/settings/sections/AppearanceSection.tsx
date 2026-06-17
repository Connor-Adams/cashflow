import { PaletteSection } from './PaletteSection'
import { DesignSystemSection } from './DesignSystemSection'

export function AppearanceSection() {
  return (
    <div className="flex flex-col gap-8">
      <PaletteSection />
      <DesignSystemSection />
    </div>
  )
}
