# Palette Enforcement CI Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CI check that guarantees frontend UI styling uses only sanctioned design tokens — no off-palette color literals (hex/rgb/hsl/named) anywhere except the token-definition file.

**Architecture:** A standalone color-aware Node script (`frontend/scripts/check-palette.mjs`) is the CI authority and the only mechanism covering CSS; a focused ESLint rule gives in-editor feedback on `.tsx`. A one-time cleanup promotes the few existing literals to tokens (avatar palette, an SVG fill, App.css `color-mix` anchors) so the tree is clean at launch. Both mechanisms are wired into a new CI lint job (CI currently runs no lint at all).

**Tech Stack:** Node 22 (ESM), vitest (frontend test runner), ESLint 9 flat config, Tailwind v4 `@theme` tokens in `frontend/src/index.css`, GitHub Actions.

## Global Constraints

- Node runtime: **22** (matches `.github/workflows/ci.yml` `node-version: '22'`).
- The script is ESM (`.mjs`), uses **only Node built-ins** — no new dependencies.
- All work is in the `frontend` workspace + two repo-root files (`ci.yml`, root `package.json`). No backend/shared changes.
- The palette = `--*` CSS variables in `frontend/src/index.css`. That file is the **only** sanctioned home for raw color literals.
- Out of scope (do not touch / do not flag): `frontend/src/extension/**`, `frontend/src/bookmarklets/**` (foreign-page bundles; their hex is legitimate), `**/*.test.{ts,tsx}`, `frontend/src/index.css`.
- Not enforced (explicit non-goals): non-color styling (spacing/layout), and Tailwind default color-scale utilities like `text-red-500` (0 exist in the codebase today).
- White → `var(--zinc-50)` (`#FAFAFA`), black → `var(--zinc-950)` (`#09090B`) — the palette has no pure white/black.
- Run all commands from the repo root. Frontend test: `yarn workspace frontend run test`. Frontend lint: `yarn workspace frontend run lint`.

---

### Task 1: Color-literal detector (`findViolations`) + tests

The pure core of the check. No filesystem, no CLI — just `source string → violations`. TDD this first; it is the highest-risk piece (comment stripping, false-positive avoidance).

**Files:**
- Create: `frontend/scripts/check-palette.mjs` (exports `blankComments`, `findViolations`)
- Test: `frontend/scripts/check-palette.test.ts`

**Interfaces:**
- Produces:
  - `blankComments(source: string): string` — returns `source` with comment characters replaced by spaces, preserving newlines and character offsets (so line numbers stay accurate); string and template-literal contents are left intact.
  - `findViolations(source: string, file: string): { line: number, value: string, why: string }[]` — `file` is used only to decide CSS-specific rules (ends with `.css`). `line` is 1-based.

- [ ] **Step 1: Write the failing test**

Create `frontend/scripts/check-palette.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { blankComments, findViolations } from './check-palette.mjs'

const find = (src: string, file = 'x.tsx') => findViolations(src, file)
const values = (src: string, file = 'x.tsx') => find(src, file).map((v) => v.value)

describe('blankComments', () => {
  it('blanks line comments but keeps the newline and offsets', () => {
    const out = blankComments('a // PR #259\nb')
    expect(out).toBe('a          \nb')
  })
  it('leaves // inside string literals alone', () => {
    const src = 'const u = "https://x.com//y"'
    expect(blankComments(src)).toBe(src)
  })
  it('blanks block comments across lines', () => {
    expect(blankComments('a/*\n#fff\n*/b')).toBe('a  \n    \n  b')
  })
})

describe('findViolations — hex', () => {
  it('flags 6-digit hex in tsx', () => {
    expect(values("const c = '#9B2D3A'")).toEqual(['#9B2D3A'])
  })
  it('flags 8-digit hex', () => {
    expect(values("const c = '#9B2D3AFF'")).toEqual(['#9B2D3AFF'])
  })
  it('does not flag a numeric PR ref in a comment', () => {
    expect(values('foo() // see PR #259')).toEqual([])
  })
  it('does not flag a 3-digit token-like ref in tsx code', () => {
    expect(values('const issue = "#259"')).toEqual([])
  })
  it('flags 3-digit hex only inside a css color value', () => {
    expect(values('a { color: #fff; }', 'x.css')).toEqual(['#fff'])
    expect(values('grid-column: #fff', 'x.css')).toEqual([]) // not a color prop
  })
})

describe('findViolations — functional + named', () => {
  it('flags rgb()/hsl()', () => {
    expect(values('background: rgb(155,45,58)', 'x.css')).toContain('rgb()')
    expect(values('color: hsl(0 0% 0%)', 'x.css')).toContain('hsl()')
  })
  it('flags named colors in a css color-mix anchor', () => {
    expect(values('border-color: color-mix(in srgb, var(--border) 88%, white 4%)', 'x.css'))
      .toEqual(['white'])
  })
  it('flags black in color-mix', () => {
    expect(values('background: color-mix(in srgb, var(--bg) 90%, black 4%)', 'x.css'))
      .toEqual(['black'])
  })
  it('flags a named color in a tsx style color key', () => {
    expect(values("style={{ color: 'red' }}")).toEqual(['red'])
  })
  it('does not flag the word red in plain JSX text', () => {
    expect(values('<span>red alert</span>')).toEqual([])
  })
})

describe('findViolations — clean / suppressed', () => {
  it('does not flag var(--token) references', () => {
    expect(values('color: var(--primary); background: var(--zinc-50)', 'x.css')).toEqual([])
  })
  it('respects // palette-allow on the line', () => {
    expect(values("const c = '#9B2D3A' // palette-allow")).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test -- check-palette`
Expected: FAIL — `Failed to resolve import './check-palette.mjs'` (file does not exist yet).

- [ ] **Step 3: Write the detector**

Create `frontend/scripts/check-palette.mjs`:

```js
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

// Replace comment chars with spaces, preserving newlines + offsets. String and
// template-literal contents are copied verbatim, so `//` inside a URL string
// and `#fff` inside a string literal are NOT treated as comments.
export function blankComments(source) {
  let out = ''
  let i = 0
  const n = source.length
  let state = 'code' // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === "'") { state = 'sq'; out += c; i++; continue }
      if (c === '"') { state = 'dq'; out += c; i++; continue }
      if (c === '`') { state = 'tpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue }
      out += ' '; i++; continue
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '; i++; continue
    }
    // string / template states
    if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue }
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`'
    if (c === quote) { state = 'code'; out += c; i++; continue }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test -- check-palette`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add frontend/scripts/check-palette.mjs frontend/scripts/check-palette.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "Add off-palette color detector with tests"
```

---

### Task 2: CLI wrapper + `lint:palette` script

Wraps the detector with a filesystem walk and exit code. After this task the script runs against the real tree and reports the existing violations (it will be RED until the Task 3–6 cleanup lands — that is expected and not wired into CI yet).

**Files:**
- Modify: `frontend/scripts/check-palette.mjs` (append CLI block)
- Modify: `frontend/package.json` (add `lint:palette` script)

**Interfaces:**
- Consumes: `findViolations` from Task 1.
- Produces: `yarn workspace frontend run lint:palette` — exits 0 when clean, 1 on any violation or if zero files match.

- [ ] **Step 1: Append the CLI wrapper to `check-palette.mjs`**

Add at the end of `frontend/scripts/check-palette.mjs`:

```js
// ── CLI ──────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url)) // frontend/
const SRC = join(FRONTEND_ROOT, 'src')
const EXCLUDED_DIRS = ['extension', 'bookmarklets']

function collectFiles() {
  const entries = readdirSync(SRC, { recursive: true, withFileTypes: true })
  return entries
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath ?? d.path, d.name))
    .filter((p) => /\.(tsx?|css)$/.test(p))
    .filter((p) => !/\.test\.(tsx?|jsx?)$/.test(p))
    .filter((p) => p !== join(SRC, 'index.css'))
    .filter((p) => {
      const rel = relative(SRC, p)
      return !EXCLUDED_DIRS.some((d) => rel === d || rel.startsWith(d + sep))
    })
}

function main() {
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
        `${relative(FRONTEND_ROOT, file)}:${v.line}: off-palette color "${v.value}" (${v.why}) — use a var(--token)`,
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
```

- [ ] **Step 2: Add the npm script**

In `frontend/package.json` `scripts`, add after the `"lint"` line:

```json
    "lint:palette": "node scripts/check-palette.mjs",
```

- [ ] **Step 3: Run it against the real tree**

Run: `yarn workspace frontend run lint:palette`
Expected: FAIL (exit 1) listing the known literals — `letter-avatar.tsx`, `security-logo.tsx`, and ~28 lines in `App.css`. The `extension/` and `bookmarklets/` files must **not** appear. This confirms detection + scoping on real code.

- [ ] **Step 4: Confirm the test suite still passes**

Run: `yarn workspace frontend run test -- check-palette`
Expected: PASS (the `if (process.argv[1] === …)` guard keeps `main()` from running under vitest).

- [ ] **Step 5: Commit**

```bash
git add frontend/scripts/check-palette.mjs frontend/package.json
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "Add check-palette CLI wrapper and lint:palette script"
```

---

### Task 3: Define avatar + on-color tokens in `index.css`

**Files:**
- Modify: `frontend/src/index.css` (add tokens inside the `:root, :root[data-theme="light"]` block, near the other palette ramps)

**Interfaces:**
- Produces tokens consumed by Task 4: `--avatar-1` … `--avatar-12`, `--avatar-on-light`, `--avatar-on-dark`.

- [ ] **Step 1: Add the tokens**

In `frontend/src/index.css`, inside the `:root, :root[data-theme="light"]` block (e.g. just after the `--chart-*` definitions), add:

```css
  /* Categorical avatar identity colors (single source of truth for LetterAvatar) */
  --avatar-1:  #5B8DEF;
  --avatar-2:  #7C5CFF;
  --avatar-3:  #10B981;
  --avatar-4:  #F59E0B;
  --avatar-5:  #EF4444;
  --avatar-6:  #06B6D4;
  --avatar-7:  #EC4899;
  --avatar-8:  #84CC16;
  --avatar-9:  #0EA5E9;
  --avatar-10: #A855F7;
  --avatar-11: #F97316;
  --avatar-12: #14B8A6;
  /* Text colors for avatar backgrounds (precomputed contrast — see LetterAvatar) */
  --avatar-on-light: var(--zinc-50);   /* light text on dark/saturated bg */
  --avatar-on-dark:  var(--zinc-900);  /* dark text on light bg */
```

Note: these `--avatar-*` lines are the *only* sanctioned literals — they live in `index.css`, which the check excludes. No dark-theme override is needed; avatar identity colors are intentionally theme-independent.

- [ ] **Step 2: Verify the dev build still compiles**

Run: `yarn workspace frontend run build`
Expected: build succeeds (Tailwind accepts the new custom properties).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "Add avatar palette tokens to index.css"
```

---

### Task 4: Refactor `LetterAvatar` to token-backed paired palette

The component currently parses the hex at runtime to choose a readable text color. Tokens hide the hex, so we precompute the foreground per entry (using the existing `luminance > 0.55` rule, evaluated once at authoring time) and delete the runtime parsing.

**Files:**
- Modify: `frontend/src/components/ui/letter-avatar.tsx`
- Test: `frontend/src/components/ui/letter-avatar.test.tsx` (create)

**Interfaces:**
- Consumes: `--avatar-1..12`, `--avatar-on-light`, `--avatar-on-dark` from Task 3.
- Produces: unchanged public API (`LetterAvatar({ text, size })`); `bg`/`color` style values become `var(--…)` strings.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui/letter-avatar.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LetterAvatar } from './letter-avatar'

describe('LetterAvatar', () => {
  it('renders the first letter uppercased', () => {
    const { getByText } = render(<LetterAvatar text="connor" />)
    expect(getByText('C')).toBeTruthy()
  })
  it('uses a var(--avatar-N) background and a var(--avatar-on-*) text color', () => {
    const { getByRole } = render(<LetterAvatar text="connor" />)
    const el = getByRole('img') as HTMLElement
    expect(el.style.backgroundColor).toMatch(/var\(--avatar-\d{1,2}\)/)
    expect(el.style.color).toMatch(/var\(--avatar-on-(light|dark)\)/)
  })
  it('is deterministic for the same text', () => {
    const a = render(<LetterAvatar text="abc" />).getByRole('img') as HTMLElement
    const b = render(<LetterAvatar text="abc" />).getByRole('img') as HTMLElement
    expect(a.style.backgroundColor).toBe(b.style.backgroundColor)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test -- letter-avatar`
Expected: FAIL — current code sets `backgroundColor` to a `#hex`, not `var(--avatar-N)`.

- [ ] **Step 3: Rewrite the palette + remove runtime hex parsing**

In `frontend/src/components/ui/letter-avatar.tsx`, replace the `PALETTE`, `readableForeground`, and `pickColor` section (the block from `const PALETTE = [` through `pickColor`) with:

```ts
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

function pick(text: string): { bg: string; fg: string } {
  return PALETTE[hashCode(text || '?') % PALETTE.length]
}
```

Then in the component body, replace:

```ts
  const bg = pickColor(text)
  const fg = readableForeground(bg)
```

with:

```ts
  const { bg, fg } = pick(text)
```

(`hashCode` stays unchanged. `readableForeground` and `pickColor` are now removed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test -- letter-avatar`
Expected: PASS.

- [ ] **Step 5: Verify the script no longer flags this file**

Run: `yarn workspace frontend run lint:palette 2>&1 | grep letter-avatar || echo "letter-avatar clean"`
Expected: `letter-avatar clean`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ui/letter-avatar.tsx frontend/src/components/ui/letter-avatar.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "Route LetterAvatar palette through avatar tokens"
```

---

### Task 5: Tokenize the `security-logo.tsx` SVG fill

**Files:**
- Modify: `frontend/src/components/ui/security-logo.tsx:45`

**Interfaces:** none (self-contained edit).

- [ ] **Step 1: Inspect the literal**

Run: `grep -n '#FFFFFF' frontend/src/components/ui/security-logo.tsx`
Expected: one match around line 45 (an SVG `fill`).

- [ ] **Step 2: Replace with a token**

Change the `fill="#FFFFFF"` (or `fill: '#FFFFFF'`) to use `var(--zinc-50)`. For an SVG attribute that is a fixed white mark, prefer `fill="var(--zinc-50)"`. If review decides this is an immutable brand glyph that must stay pure white, instead append `{/* palette-allow */}` / `// palette-allow` on that line — but default to tokenizing.

- [ ] **Step 3: Verify the file is clean and renders**

Run: `yarn workspace frontend run lint:palette 2>&1 | grep security-logo || echo "security-logo clean"`
Expected: `security-logo clean`.
Run: `yarn workspace frontend run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ui/security-logo.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "Tokenize security-logo fill"
```

---

### Task 6: Clean up `App.css` raw white/black/#fff

The detector itself is the worklist. Replace each flagged literal with its palette token, re-run until clean.

**Files:**
- Modify: `frontend/src/App.css`

**Interfaces:** none.

- [ ] **Step 1: Get the worklist**

Run: `yarn workspace frontend run lint:palette 2>&1 | grep 'App.css'`
Expected: ~28 lines — `color-mix(…)` anchors using `white`/`black`, plus three `color: #fff`.

- [ ] **Step 2: Apply the mapping to each flagged line**

For every `App.css` line the script reports, replace the literal with its token:

| Literal | Replacement |
|---|---|
| `white` (as a `color-mix` anchor or color value) | `var(--zinc-50)` |
| `black` (as a `color-mix` anchor or color value) | `var(--zinc-950)` |
| `#fff` / `#ffffff` | `var(--zinc-50)` |
| `#000` / `#000000` | `var(--zinc-950)` |

Edit only the reported lines. Do **not** blanket-replace the strings "white"/"black" across the file — class names or comments may contain them; the script only flags color-context occurrences, so trust its line list.

- [ ] **Step 3: Re-run until clean**

Run: `yarn workspace frontend run lint:palette`
Expected: eventually `check-palette: <N> files clean.` (exit 0). Repeat Step 2 for any remaining App.css hits.

- [ ] **Step 4: Visual sanity check**

Run: `yarn workspace frontend run build`
Expected: build succeeds. (The `color-mix` results shift slightly — `#FAFAFA`/`#09090B` vs pure white/black — which is the intended palette-sanctioned behavior.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.css
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "Route App.css color-mix anchors through greyscale tokens"
```

---

### Task 7: ESLint rule for hex literals + arbitrary Tailwind color brackets

In-editor feedback layer on `.tsx`. Must pass on the now-clean tree.

**Files:**
- Modify: `frontend/eslint.config.js`

**Interfaces:** none (rides existing `yarn lint`).

- [ ] **Step 1: Add the `no-restricted-syntax` rule**

In `frontend/eslint.config.js`, inside the existing `rules` object (alongside the `react-hooks/set-state-in-effect` entry), add:

```js
      'no-restricted-syntax': [
        'error',
        {
          // Raw hex color literals in component code — use a var(--token).
          selector:
            "Literal[value=/#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\\b/]",
          message:
            'Off-palette hex color. Use a design token: var(--token) or a token-backed class.',
        },
        {
          // Arbitrary Tailwind color brackets, e.g. bg-[#fff], text-[rgb(...)].
          selector:
            "Literal[value=/(?:bg|text|border|ring|fill|stroke|from|to|via|decoration|outline|shadow|divide|accent|caret)-\\[(?:#|rgb|hsl)/]",
          message:
            'Arbitrary Tailwind color value. Use a token-backed color class instead.',
        },
      ],
```

Note: `no-restricted-syntax` with a regex `Literal` selector matches string/numeric literal *values*. It does not see CSS files — that is the script's job (which is why both layers exist). Test fixtures under `**/*.test.tsx` that legitimately contain hex (e.g. detector tests) should carry an inline `// eslint-disable-next-line no-restricted-syntax` where needed; check the lint run for any such case.

- [ ] **Step 2: Run lint**

Run: `yarn workspace frontend run lint`
Expected: PASS. If `frontend/scripts/check-palette.test.ts` or other test files trip the hex rule, add a targeted `// eslint-disable-next-line no-restricted-syntax` (or scope the rule's `files` to exclude `**/*.test.*`) — prefer excluding test files via a config block since fixtures intentionally contain literals:

```js
  {
    files: ['**/*.test.{ts,tsx}', 'scripts/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
```

Add that block to the exported config array if test/fixture files trip the rule.

- [ ] **Step 3: Quick negative check**

Temporarily add `const x = '#abc123'` to any non-test `.tsx`, run `yarn workspace frontend run lint`, confirm it errors, then remove it.

- [ ] **Step 4: Commit**

```bash
git add frontend/eslint.config.js
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "Add ESLint rule banning hex literals and arbitrary Tailwind color brackets"
```

---

### Task 8: Wire both checks into CI + local `yarn ci`

**Files:**
- Modify: `.github/workflows/ci.yml` (add a `frontend-lint` job)
- Modify: `package.json` (root `ci` script)

**Interfaces:** none.

- [ ] **Step 1: Add the `frontend-lint` job**

In `.github/workflows/ci.yml`, add a new job (mirror the `frontend-test` job's setup), e.g. directly before `frontend-test`:

```yaml
  frontend-lint:
    needs: install
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: '22'

      - name: Download node_modules artifact
        uses: actions/download-artifact@v8
        with:
          name: node_modules

      - name: Extract node_modules
        run: tar -xf node_modules.tar

      - name: ESLint
        run: yarn workspace frontend run lint

      - name: Palette check
        run: yarn workspace frontend run lint:palette
```

- [ ] **Step 2: Add to local `yarn ci`**

In root `package.json`, append to the `"ci"` script value:

```
 && yarn workspace frontend run lint && yarn workspace frontend run lint:palette
```

(Append at the end of the existing `ci` command string.)

- [ ] **Step 3: Verify the full local gate is green**

Run: `yarn workspace frontend run lint && yarn workspace frontend run lint:palette`
Expected: ESLint passes; `check-palette: <N> files clean.` exit 0.

Run (YAML sanity): `node -e "require('js-yaml')" 2>/dev/null && yarn --silent dlx js-yaml .github/workflows/ci.yml >/dev/null && echo "yaml ok" || echo "skip yaml lint"`
Expected: `yaml ok` or skip — the job is also validated by CI itself on push.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml package.json
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "Run ESLint and palette check in CI and yarn ci"
```

---

## Self-Review

**Spec coverage:**
- Authoritative script (detection rules, comment-strip, exclusions, exit codes) → Tasks 1–2. ✓
- ESLint rule (hex + arbitrary brackets) → Task 7. ✓
- Token promotion: avatar tokens → Task 3; LetterAvatar runtime constraint → Task 4; security-logo → Task 5; App.css black/white → Task 6. ✓
- Wiring (new `frontend-lint` CI job + root `yarn ci`; the "CI has no lint job today" finding) → Task 8. ✓
- Tests table from spec → Task 1 test cases (hex, PR ref, var(), palette-allow, rgb, bracket via ESLint, color-mix white, named in css, word "red"). ✓ (Tailwind-bracket case is covered by the ESLint rule + negative check in Task 7, not the script test — consistent with the design's split.)

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. App.css cleanup (Task 6) is tool-driven with an exact mapping table + verification gate rather than enumerating 28 lines — a defined procedure, not a placeholder.

**Type/name consistency:** `findViolations`/`blankComments` signatures match between Task 1 (definition), Task 1 tests, and Task 2 (CLI consumer). `pick()`/`hashCode` names consistent within Task 4. Token names (`--avatar-1..12`, `--avatar-on-light`, `--avatar-on-dark`) identical between Task 3 (definition) and Task 4 (consumption). `lint:palette` script name identical across Tasks 2, 4, 5, 6, 8.
