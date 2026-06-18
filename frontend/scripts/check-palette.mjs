// Detects off-palette color literals. Pure functions only — the CLI wrapper
// (added in Task 2) does the filesystem walk and process.exit.

const ALLOW_MARKER = 'palette-allow'

// CSS named colors treated as off-palette when used in a color context.
const NAMED_COLORS = new Set([
  'white', 'black', 'gray', 'grey', 'red', 'green', 'blue', 'yellow',
  'orange', 'purple', 'pink', 'cyan', 'magenta', 'lime', 'teal', 'navy',
  'maroon', 'olive', 'silver', 'gold', 'brown', 'indigo', 'violet',
  'crimson', 'coral', 'salmon', 'turquoise', 'khaki', 'beige', 'ivory',
])

// A color is "in context" on a line if a color property precedes it or the
// line uses color-mix(). Covers css declarations and tsx inline-style keys.
const COLOR_PROP_RE =
  /\b(color|background|background-color|backgroundColor|border|border-(?:color|top-color|bottom-color|left-color|right-color)|borderColor|outline|outline-color|fill|stroke|box-shadow|boxShadow|text-shadow|textShadow|caret-color|caretColor|accent-color|accentColor|stop-color|flood-color|lighting-color)\s*[:=]/

function inColorContext(line) {
  return COLOR_PROP_RE.test(line) || line.includes('color-mix(')
}

// Replace comment chars with spaces, preserving newlines + offsets. String,
// template-literal, and regex-literal contents are copied verbatim, so `//`
// inside a URL string, `//` inside a regex, and `#fff` inside a string are
// NOT treated as comments.
export function blankComments(source) {
  let out = ''
  let i = 0
  const n = source.length
  let state = 'code' // code | line | block | sq | dq | tpl | regex
  // Track the previous significant (non-whitespace) char emitted while in
  // `code` state, to distinguish division `/` from regex-literal `/`.
  let prevSig = '' // '' = start-of-input
  // A `/` starts a regex literal when the previous significant char is one of
  // these, or when there is no previous significant char (start of input).
  const REGEX_STARTERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '*', '>', ''])
  let regexInClass = false // inside [...] inside a regex
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += ' '; i += 2; continue }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === '/') {
        // Decide: regex start or division?
        if (REGEX_STARTERS.has(prevSig)) {
          state = 'regex'; regexInClass = false; out += c; i++; continue
        }
        // Division — copy and fall through to prevSig update below
        out += c; prevSig = '/'; i++; continue
      }
      if (c === "'") { state = 'sq'; out += c; prevSig = "'"; i++; continue }
      if (c === '"') { state = 'dq'; out += c; prevSig = '"'; i++; continue }
      if (c === '`') { state = 'tpl'; out += c; prevSig = '`'; i++; continue }
      out += c
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prevSig = c
      i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue }
      out += ' '; i++; continue
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '; i++; continue
    }
    if (state === 'regex') {
      if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue }
      if (c === '[') { regexInClass = true; out += c; i++; continue }
      if (c === ']') { regexInClass = false; out += c; i++; continue }
      if (c === '/' && !regexInClass) {
        // Closing delimiter — consume optional flags (letters) verbatim
        state = 'code'; out += c; i++
        while (i < n && /[gimsuy]/.test(source[i])) { out += source[i]; i++ }
        prevSig = '/'
        continue
      }
      out += c; i++; continue
    }
    // string / template states
    if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue }
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`'
    if (c === quote) { state = 'code'; out += c; prevSig = c; i++; continue }
    out += c; i++; continue
  }
  return out
}

export function findViolations(source, file) {
  const isCss = file.endsWith('.css')
  const masked = blankComments(source)
  const origLines = source.split('\n')
  const lines = masked.split('\n')
  const out = []
  const push = (idx, value, why) => {
    if ((origLines[idx] ?? '').includes(ALLOW_MARKER)) return
    out.push({ line: idx + 1, value, why })
  }
  lines.forEach((line, idx) => {
    // 6/8-digit hex anywhere (8 tried first so it isn't split into a 6 + tail).
    for (const m of line.matchAll(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b/g)) {
      push(idx, m[0], 'hex color literal')
    }
    // 3/4-digit hex: only inside a css color value (avoids numeric refs in tsx).
    if (isCss && inColorContext(line)) {
      for (const m of line.matchAll(/#[0-9a-fA-F]{3,4}\b/g)) {
        push(idx, m[0], 'short hex color literal')
      }
    }
    // functional colors
    for (const m of line.matchAll(/\b(rgba?|hsla?)\s*\(/gi)) {
      push(idx, `${m[1].toLowerCase()}()`, 'functional color literal')
    }
    // named colors, only in a color context, not when part of a --token name
    if (inColorContext(line)) {
      for (const m of line.matchAll(/[a-z]+/gi)) {
        const w = m[0].toLowerCase()
        if (!NAMED_COLORS.has(w)) continue
        if (line[m.index - 1] === '-') continue // e.g. --white token name
        push(idx, w, 'named color literal')
      }
    }
  })
  return out
}

// ── CLI ──────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXCLUDED_DIRS = ['extension', 'bookmarklets']

function collectFiles() {
  const frontendRoot = fileURLToPath(new URL('..', import.meta.url)) // frontend/
  const src = join(frontendRoot, 'src')
  const entries = readdirSync(src, { recursive: true, withFileTypes: true })
  return entries
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath ?? d.path, d.name))
    .filter((p) => /\.(tsx?|css)$/.test(p))
    .filter((p) => !/\.test\.(tsx?|jsx?)$/.test(p))
    .filter((p) => p !== join(src, 'index.css'))
    .filter((p) => {
      const rel = relative(src, p)
      return !EXCLUDED_DIRS.some((d) => rel === d || rel.startsWith(d + sep))
    })
}

function main() {
  const frontendRoot = fileURLToPath(new URL('..', import.meta.url))
  const files = collectFiles()
  if (files.length === 0) {
    console.error('check-palette: matched 0 files — refusing to pass silently.')
    process.exit(1)
  }
  let total = 0
  for (const file of files) {
    const violations = findViolations(readFileSync(file, 'utf8'), file)
    for (const v of violations) {
      console.error(
        `${relative(frontendRoot, file)}:${v.line}: off-palette color "${v.value}" (${v.why}) — use a var(--token)`,
      )
      total++
    }
  }
  if (total > 0) {
    console.error(`\ncheck-palette: ${total} off-palette color literal(s) found.`)
    process.exit(1)
  }
  console.log(`check-palette: ${files.length} files clean.`)
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) main()
