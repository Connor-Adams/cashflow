import { useEffect, useState } from 'react'

type Swatch = { label: string; token: string }
type Group = { name: string; swatches: Swatch[] }

const GROUPS: Group[] = [
  {
    name: 'Greyscale',
    swatches: [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((n) => ({
      label: `zinc-${n}`,
      token: `--zinc-${n}`,
    })),
  },
  {
    name: 'Oxblood',
    swatches: [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => ({
      label: `oxblood-${n}`,
      token: `--oxblood-${n}`,
    })),
  },
  {
    name: 'Green',
    swatches: [100, 200, 300, 500, 600, 700].map((n) => ({
      label: `green-${n}`,
      token: `--green-${n}`,
    })),
  },
  {
    name: 'Semantic',
    swatches: [
      { label: 'background', token: '--background' },
      { label: 'card', token: '--card' },
      { label: 'foreground', token: '--foreground' },
      { label: 'primary', token: '--primary' },
      { label: 'positive', token: '--positive' },
      { label: 'negative', token: '--negative' },
      { label: 'warning', token: '--warning' },
      { label: 'danger', token: '--danger' },
      { label: 'info', token: '--info' },
      { label: 'text-link', token: '--text-link' },
      { label: 'border', token: '--border' },
    ],
  },
  { name: 'Gradient', swatches: [{ label: 'gradient-hero', token: '--gradient-hero' }] },
]

function useTokenValues(tokens: string[]): Record<string, string> {
  const key = tokens.join(',')
  const [vals, setVals] = useState<Record<string, string>>({})
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement)
      const next: Record<string, string> = {}
      for (const t of tokens) next[t] = cs.getPropertyValue(t).trim()
      setVals(next)
    }
    read()
    const obs = new MutationObserver(read)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return vals
}

export function PaletteSection() {
  const allTokens = GROUPS.flatMap((g) => g.swatches.map((s) => s.token))
  const values = useTokenValues(allTokens)
  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-foreground">Palette</h2>
      <p className="text-sm text-muted-foreground">
        Live design tokens, read from CSS at runtime. Reflects the active theme.
      </p>
      {GROUPS.map((group) => (
        <div key={group.name} className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">{group.name}</h3>
          <div className="flex flex-wrap gap-2">
            {group.swatches.map((s) => {
              const v = values[s.token] ?? ''
              const isGradient = s.token === '--gradient-hero'
              return (
                <div key={s.token} className="flex flex-col items-center gap-1">
                  <div
                    className="h-12 w-16 rounded-md border border-border"
                    style={
                      isGradient ? { backgroundImage: v } : { backgroundColor: `var(${s.token})` }
                    }
                  />
                  <span className="text-[10px] text-muted-foreground">{s.label}</span>
                  <span
                    data-testid="swatch-value"
                    className="font-mono text-[9px] text-muted-foreground"
                  >
                    {v}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </section>
  )
}
