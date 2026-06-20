import { Card } from '@connor-adams/designsystem'
import type { PortfolioByAccountTypeWarning } from '../../types/api'

export type TaxWarningsStripProps = {
  warnings: PortfolioByAccountTypeWarning[]
}

export function TaxWarningsStrip({ warnings }: TaxWarningsStripProps) {
  if (warnings.length === 0) return null
  return (
    <Card className="my-3" style={{ borderLeft: '3px solid var(--accent-warm)' }}>
      <ul className="text-sm" style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
        {warnings.map((w, i) => (
          <li key={`${w.kind}-${w.securityId}-${i}`}>
            ⚠️ <span>{w.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
