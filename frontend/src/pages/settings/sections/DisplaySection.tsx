import { Card } from '@cashflow/ui'
import { useLayoutWidth, layoutWidthOptions } from '@/lib/layoutWidth'

export function DisplaySection() {
  const [layoutWidth, setLayoutWidth] = useLayoutWidth()

  return (
    <Card className="settingsDisplayCard">
      <div className="accountsCardHeader">
        <div>
          <h2>Display width</h2>
          <p className="muted">Choose how much horizontal space the app can use on this browser.</p>
        </div>
      </div>
      <div className="settingsWidthOptions" role="radiogroup" aria-label="Display width">
        {layoutWidthOptions.map((option) => (
          <label className="settingsWidthOption" key={option.value}>
            <input
              type="radio"
              name="layoutWidth"
              value={option.value}
              checked={layoutWidth === option.value}
              onChange={() => setLayoutWidth(option.value)}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
          </label>
        ))}
      </div>
    </Card>
  )
}
