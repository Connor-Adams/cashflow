# Palette Enforcement CI Check — Design

**Date:** 2026-06-18
**Status:** Approved (design); implementation pending
**Topic:** A CI check that guarantees frontend UI styling only uses sanctioned design tokens, never off-palette color literals.

## Problem

Cashflow has a forced color palette defined as `--*` CSS variables in
`frontend/src/index.css` (greyscale/oxblood/green/amber ramps + semantic
signal tokens like `--success`, `--danger`, `--primary`, plus `--chart-*`).
Nothing currently prevents a contributor from introducing an off-palette color
— a raw hex, `rgb()`, or named color — in component code or `App.css`. Over
time that drifts the UI away from the single source of truth.

We want CI to **guarantee no off-palette color literal enters the frontend.**

### Audit (2026-06-18)

A naive `grep '#[0-9a-fA-F]{3,8}'` over `.tsx` reports ~145 "hex" hits, but
~90% are false positives — GitHub PR/issue refs in comments (`#259`, `#378`)
and 3-digit fragments. The real surface is small:

- **15** genuine 6/8-digit color hexes in non-test `.tsx`.
- Dominated by `frontend/src/components/ui/letter-avatar.tsx` — a 12-color
  categorical avatar palette (Tailwind-default hues, off the oxblood/zinc
  system).
- Charts are **already tokenized** via `--chart-*` (0 literal `fill="#..."`).

So a fix-first rollout is viable — no baseline/snapshot needed.

## Definition of "off-palette"

The palette is the set of `--*` tokens in `frontend/src/index.css`. That file
is the **only** sanctioned home for raw color literals. Anywhere else, a color
must be referenced through a token (`var(--token)` or a token-backed Tailwind
class). A **violation** is any color literal — hex, `rgb()/rgba()`,
`hsl()/hsla()`, or a CSS named color in a color context — that appears outside
`index.css` and is not a `var(--…)` reference.

## Architecture

Two complementary mechanisms plus a one-time token promotion.

### 1. Authoritative check — `frontend/scripts/check-palette.mjs`

A standalone Node (ESM) script. Sole authority for CI and the only mechanism
that covers CSS (`App.css`), which ESLint cannot parse.

**Structure:** a pure exported `findViolations(source, filename) ->
Violation[]` plus a thin CLI wrapper that globs files, calls it, prints a
report, and sets the exit code. The split keeps the detector unit-testable
without filesystem or process concerns.

**Scope:** scans `frontend/src/**/*.{tsx,ts,css}`. Excludes:
- `frontend/src/index.css` — the sanctioned token-definition home.
- `**/*.test.{ts,tsx}` — test fixtures legitimately contain arbitrary strings.
- `frontend/src/extension/**` and `frontend/src/bookmarklets/**` — these bundles
  are injected into foreign pages (Amazon/Apple) and the extension service
  worker, where the app's `index.css` tokens do **not** resolve. Their hex
  colors (`extension/background.ts`, `bookmarklets/scrape/toast.ts`) are
  legitimate self-contained literals, not app UI — tokenizing them would break
  them. They live outside the palette by design.

**Detection (color-aware, false-positive-safe):**
1. Strip `//` line comments and `/* */` block comments first. This removes
   `// PR #259`-style refs before any matching.
2. **Hex:** flag `#` + exactly 6 or 8 hex digits anywhere in remaining code.
   Flag 3/4-digit hex **only inside CSS declaration values** (`.css` files,
   right of a `:` in a declaration). This prevents numeric refs like `#259`
   from ever matching as a 3-digit hex in `.tsx`.
3. **Functional colors:** flag `rgb(`, `rgba(`, `hsl(`, `hsla(` literals.
4. **Named colors:** flag a curated set of CSS named colors (`red`, `blue`,
   `white`, `black`, `gray`, …) **only in color-property position** — a CSS
   `color:`/`background*:`/`border*:`/`fill:`/`stroke:` value (this includes
   `color-mix(…)` anchor arguments), or a JSX inline `style` object color key.
   Avoids matching the word "red" in prose/JSX text. **No carve-out for
   black/white** — they are violations too (see Token promotion).
5. Never flag a value that is a `var(--…)` reference.

**Comment stripping must be string-aware.** A naive strip-to-EOL on `//` would
corrupt lines containing a URL string literal (`"https://…"`, 3 such in tsx).
Strip only `//` / `/* */` that are not inside a string or template literal.

**Escape hatch:** a `// palette-allow` or `/* palette-allow */` marker on the
same line suppresses that line. A small `PATH_ALLOWLIST` array in the script
covers whole-file exceptions if ever needed (expected: empty at launch).

**Output & exit:**
- Clean → exit 0.
- Violations → grouped report, one line each:
  `frontend/src/foo.tsx:42: off-palette color "#9B2D3A" — use a var(--token)`,
  then exit 1.
- Zero files matched by the glob → exit 1 (guards a silent empty run, matching
  the `backend/scripts/run-unit-tests.sh` convention).

### 2. ESLint rule (editor feedback) — `frontend/eslint.config.js`

Adds a `no-restricted-syntax` entry targeting string `Literal` /
`JSXAttribute` nodes that contain:
- a hex color literal, and
- an **arbitrary Tailwind color bracket** (`bg-[#…]`, `text-[rgb(…)]`,
  `border-[hsl(…)]`, `ring-/fill-/stroke-/from-/to-/via-[…]`).

There are currently **0** arbitrary-bracket violations, so this is a cheap
guardrail that keeps it that way and surfaces drift live in the editor. It
rides the existing `yarn lint` (already in CI). It deliberately does **not**
try to cover CSS — the script owns that. Partial overlap with the script on
tsx hex literals is intentional: ESLint = fast in-editor feedback, script =
authoritative + CSS coverage.

### 3. Token promotion (one-time cleanup)

- Add `--avatar-1 .. --avatar-12` to `index.css` holding the 12 categorical
  hexes currently inlined in `letter-avatar.tsx`. Palette stays the single
  source of truth — even categorical colors live in the token file.
  - **Constraint:** `letter-avatar.tsx` parses the hex at runtime
    (`readableForeground()` does `parseInt(bgHex.slice(1,3),16)`) to pick a
    readable text color. A `var(--…)` string breaks that parse. So we cannot
    just swap the strings. Instead, **precompute** the foreground per palette
    entry (apply the existing `luminance > 0.55` rule once, at authoring time)
    and store the palette as paired token references:
    `PALETTE = [{ bg: 'var(--avatar-1)', fg: 'var(--avatar-on-light)' }, …]`.
    The dark-text entries (luminance > 0.55) are indices 3, 4, 6, 8, 12; the
    rest take light text. `--avatar-on-dark` → `var(--zinc-900)`,
    `--avatar-on-light` → `var(--zinc-50)`. This deletes `readableForeground`
    and the runtime hex parsing entirely.
- `security-logo.tsx` has one `#FFFFFF` in an SVG `fill`. Tokenize to
  `var(--zinc-50)` if it should track the palette, or mark `// palette-allow`
  if it is a fixed brand asset (implementer's call — default to tokenize).
- `NetWorthTile` / `UtilizationBadge` are **not** violations — their earlier
  apparent hex hits were 3-digit / PR-ref false positives.
- **App.css raw black/white → greyscale tokens.** ~25 `color-mix(…)` anchors
  use raw `white`/`black`, plus 3 `color: #fff`. Per the palette rule these are
  off-palette. Rewrite `white` → `var(--zinc-50)` (`#FAFAFA`) and `black` →
  `var(--zinc-950)` (`#09090B`). Note: this is a deliberate, slight shift from
  pure `#fff`/`#000` to the palette extremes — accepted, since the palette
  defines no pure white/black.

After this (~43 literals total: ~15 tsx in `letter-avatar` + `security-logo`,
~28 css), the check passes on a clean tree at launch. The `extension/` and
`bookmarklets/` hexes are out of scope and untouched.

## Wiring

**Finding:** `.github/workflows/ci.yml` currently has **no lint job** — ESLint
(`yarn lint`) is not run in CI at all, and the root `yarn ci` aggregate skips
lint too. So both mechanisms need explicit wiring to actually gate merges.

- `frontend/package.json`: add `"lint:palette": "node scripts/check-palette.mjs"`.
- `.github/workflows/ci.yml`: add a new `frontend-lint` job (mirroring the
  `frontend-test` job's `needs: install` + download/extract node_modules
  pattern) that runs **both** `yarn workspace frontend run lint` (the ESLint
  rule) and `yarn workspace frontend run lint:palette` (the script). This is
  the first time ESLint is enforced in CI — a deliberate, in-scope addition.
- Root `package.json` `ci` script: append
  `&& yarn workspace frontend run lint && yarn workspace frontend run lint:palette`
  so a local `yarn ci` catches violations before push.

## Testing

vitest (frontend convention) exercising `findViolations` directly:

| Input | Expected |
|---|---|
| `color: #9B2D3A` (css) | flagged |
| `style={{ color: '#9B2D3A' }}` (tsx) | flagged |
| `// see PR #259` | not flagged (comment stripped) |
| `#259` numeric ref in `.tsx` code | not flagged (3-digit, not in css value) |
| `color: var(--primary)` | not flagged |
| `background: rgb(155, 45, 58)` | flagged |
| `className="bg-[#fff]"` | flagged |
| `color: #9B2D3A // palette-allow` | suppressed |
| named color `color: red` (css) | flagged |
| `color-mix(in srgb, var(--border) 88%, white 4%)` | flagged (raw `white`) |
| `color-mix(in srgb, var(--border) 88%, var(--zinc-50) 4%)` | not flagged |
| `color: #fff` (css, 3-digit) | flagged |
| `"https://x.com//y"` URL in tsx | not flagged (string-aware strip) |
| the word "red" in JSX text | not flagged |

## Non-goals / YAGNI

- No `--fix`/auto-rewrite — report only.
- No baseline/snapshot file — fix-first, the surface is ~15 literals.
- No stylelint dependency — the standalone script covers CSS.
- Not enforcing non-color styling (spacing, layout inline styles stay allowed).

## Rollout

1. Promote avatar + straggler colors to tokens (tree goes clean).
2. Land script + tests + ESLint rule + wiring in the same change so CI is green
   on merge.
