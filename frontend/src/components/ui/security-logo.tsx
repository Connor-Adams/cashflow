import { useState } from 'react'
import { LetterAvatar, type LetterAvatarSize } from './letter-avatar'
import { securityLogoUrl } from '../../lib/securityLogo'

const SIZE_PX: Record<LetterAvatarSize, number> = {
  sm: 24,
  md: 32,
  lg: 48,
  xl: 64,
}

export type SecurityLogoProps = {
  symbol: string
  name?: string | null
  size?: LetterAvatarSize
  assetType?: string | null
  currency?: string | null
}

export function SecurityLogo({
  symbol,
  name,
  size = 'md',
  assetType,
  currency,
}: SecurityLogoProps) {
  const url = securityLogoUrl(symbol, { assetType, currency })
  const [errored, setErrored] = useState(false)
  if (!url || errored) {
    return <LetterAvatar text={symbol || name || '?'} size={size} />
  }
  const px = SIZE_PX[size]
  return (
    <img
      src={url}
      alt={name ? `${name} logo` : `${symbol} logo`}
      width={px}
      height={px}
      onError={() => setErrored(true)}
      style={{
        width: `${px}px`,
        height: `${px}px`,
        borderRadius: 6,
        objectFit: 'contain',
        backgroundColor: 'var(--zinc-50)',
        border: '1px solid var(--border)',
        flexShrink: 0,
      }}
    />
  )
}
