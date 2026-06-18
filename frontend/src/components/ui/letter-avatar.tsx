import type { CSSProperties } from 'react'

export type LetterAvatarSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_PX: Record<LetterAvatarSize, number> = {
  sm: 24,
  md: 32,
  lg: 48,
  xl: 64,
}

// Categorical avatar colors live in index.css as --avatar-1..12. The text color
// is precomputed here per entry (original rule: luminance > 0.55 → dark text)
// because a var(--…) string can't be parsed for luminance at runtime.
// Dark-text entries (luminance > 0.55): indices 3, 4, 6, 8, 12.
const PALETTE: { bg: string; fg: string }[] = [
  { bg: 'var(--avatar-1)',  fg: 'var(--avatar-on-light)' },
  { bg: 'var(--avatar-2)',  fg: 'var(--avatar-on-light)' },
  { bg: 'var(--avatar-3)',  fg: 'var(--avatar-on-dark)' },
  { bg: 'var(--avatar-4)',  fg: 'var(--avatar-on-dark)' },
  { bg: 'var(--avatar-5)',  fg: 'var(--avatar-on-light)' },
  { bg: 'var(--avatar-6)',  fg: 'var(--avatar-on-dark)' },
  { bg: 'var(--avatar-7)',  fg: 'var(--avatar-on-light)' },
  { bg: 'var(--avatar-8)',  fg: 'var(--avatar-on-dark)' },
  { bg: 'var(--avatar-9)',  fg: 'var(--avatar-on-light)' },
  { bg: 'var(--avatar-10)', fg: 'var(--avatar-on-light)' },
  { bg: 'var(--avatar-11)', fg: 'var(--avatar-on-light)' },
  { bg: 'var(--avatar-12)', fg: 'var(--avatar-on-dark)' },
]

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function pick(text: string): { bg: string; fg: string } {
  return PALETTE[hashCode(text || '?') % PALETTE.length]
}

export type LetterAvatarProps = {
  text: string
  size?: LetterAvatarSize
}

export function LetterAvatar({ text, size = 'md' }: LetterAvatarProps) {
  const ch = (text.trim().charAt(0) || '?').toUpperCase()
  const { bg, fg } = pick(text)
  const px = SIZE_PX[size]
  const style: CSSProperties = {
    width: `${px}px`,
    height: `${px}px`,
    borderRadius: 6,
    backgroundColor: bg,
    color: fg,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: `${Math.floor(px * 0.5)}px`,
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none',
    flexShrink: 0,
  }
  return (
    <span role="img" aria-label={`Avatar for ${text}`} style={style}>
      {ch}
    </span>
  )
}
