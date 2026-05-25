import * as React from 'react'
import type { CSSProperties } from 'react'

export type LetterAvatarSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_PX: Record<LetterAvatarSize, number> = {
  sm: 24,
  md: 32,
  lg: 48,
  xl: 64,
}

const PALETTE = [
  '#5B8DEF', '#7C5CFF', '#10B981', '#F59E0B', '#EF4444',
  '#06B6D4', '#EC4899', '#84CC16', '#0EA5E9', '#A855F7',
  '#F97316', '#14B8A6',
]

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function pickColor(text: string): string {
  return PALETTE[hashCode(text || '?') % PALETTE.length]
}

function readableForeground(bgHex: string): string {
  const r = parseInt(bgHex.slice(1, 3), 16)
  const g = parseInt(bgHex.slice(3, 5), 16)
  const b = parseInt(bgHex.slice(5, 7), 16)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance > 0.55 ? '#111827' : '#FFFFFF'
}

export type LetterAvatarProps = {
  text: string
  size?: LetterAvatarSize
}

export function LetterAvatar({ text, size = 'md' }: LetterAvatarProps) {
  const ch = (text.trim().charAt(0) || '?').toUpperCase()
  const bg = pickColor(text)
  const fg = readableForeground(bg)
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
