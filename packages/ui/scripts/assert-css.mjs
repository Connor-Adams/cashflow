// Verifies the compiled stylesheet carries the load-bearing pieces.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../dist/cashflow-ui.css', import.meta.url), 'utf8')
const required = [
  '#9b2d3a',          // oxblood-500 token value (minifier lowercases hex)
  '--primary',        // semantic token present
  'skeleton-shimmer', // keyframe class shipped
  '.rounded-lg',      // used by Button/Card
  '.bg-button-primary', // custom @utility emitted for Button
]
const missing = required.filter((needle) => !css.toLowerCase().includes(needle.toLowerCase()))
if (missing.length > 0) {
  console.error('cashflow-ui.css missing:', missing.join(', '))
  process.exit(1)
}
// Preflight must NOT be present (no global reset shipped).
if (/\*,\s*::before,\s*::after\s*{[^}]*box-sizing:\s*border-box/.test(css)) {
  console.error('cashflow-ui.css unexpectedly contains preflight reset')
  process.exit(1)
}
console.log('cashflow-ui.css OK (%d bytes)', css.length)
