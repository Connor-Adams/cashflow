import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'cashflow.layoutWidth'
const CHANGE_EVENT = 'cashflow:layout-width-change'

export const layoutWidthOptions = [
  {
    value: 'standard',
    label: 'Standard',
    description: 'Current focused layout for laptops and smaller displays.',
  },
  {
    value: 'wide',
    label: 'Wide',
    description: 'More room for tables, filters, and dashboard charts.',
  },
  {
    value: 'ultrawide',
    label: 'Ultrawide',
    description: 'Uses a 5K2K-friendly canvas for dense finance work.',
  },
] as const

export type LayoutWidth = (typeof layoutWidthOptions)[number]['value']

const layoutWidthValues = new Set<LayoutWidth>(
  layoutWidthOptions.map((option) => option.value),
)

export function getLayoutWidth(): LayoutWidth {
  if (typeof window === 'undefined') return 'standard'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return layoutWidthValues.has(stored as LayoutWidth) ? (stored as LayoutWidth) : 'standard'
}

export function setLayoutWidth(value: LayoutWidth) {
  window.localStorage.setItem(STORAGE_KEY, value)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function useLayoutWidth() {
  const [layoutWidth, setLayoutWidthState] = useState<LayoutWidth>(() => getLayoutWidth())

  useEffect(() => {
    function handleChange() {
      setLayoutWidthState(getLayoutWidth())
    }

    window.addEventListener(CHANGE_EVENT, handleChange)
    window.addEventListener('storage', handleChange)
    return () => {
      window.removeEventListener(CHANGE_EVENT, handleChange)
      window.removeEventListener('storage', handleChange)
    }
  }, [])

  const updateLayoutWidth = useCallback((value: LayoutWidth) => {
    setLayoutWidth(value)
    setLayoutWidthState(value)
  }, [])

  return [layoutWidth, updateLayoutWidth] as const
}
