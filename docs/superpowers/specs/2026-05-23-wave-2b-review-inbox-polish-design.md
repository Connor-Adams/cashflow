# Wave 2b — Review Inbox polish

**Date:** 2026-05-23
**Status:** approved (brainstorming), implementing
**Scope:** one PR. Pure polish — no route changes, no API changes, no component restructure. Tightens the existing two-pane Review Inbox.

**Predecessor:** [`2026-05-23-wave-2a-transactions-decomposition-design.md`](./2026-05-23-wave-2a-transactions-decomposition-design.md)

---

## Goals

- Make the keyboard-driven cursor row more visible (it's the focal point of the workflow).
- Surface keyboard shortcuts inline so the user doesn't have to click the Shortcuts button to remember `j/k/space/c/Enter`.
- Clean up two inline-style escape hatches (`.reviewInboxTable tr` cursor style, the "Why?" button) into proper CSS classes.
- Give the decision panel a subtle visual lift to match the bento hero tile pattern (amber gradient at top edge).
- Migrate `.reviewInbox*` selectors off legacy aliases (`--bg2`, `--bg3`, `--accent-green`, `--muted`) onto canonical Honey & Ink tokens.

## Non-goals

- No restructure (two-pane stays). No bento at top (user explicitly picked "polish only").
- No new fields in the decision panel.
- No changes to the bulk-patch / rule-creation workflow.
- No keyboard shortcut additions.

---

## Changes

### 1. Cursor row visibility

**Today** (`ReviewInboxPage.tsx` ~line 598-606): inline style on the row.
```tsx
style={isCursor ? {
  boxShadow: 'inset 3px 0 0 0 var(--accent)',
  background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
} : undefined}
```

**After**: drop the inline `style` entirely. The row already has `data-cursor={isCursor ? 'true' : undefined}`. Add CSS:

```css
.reviewInboxTable tr[data-cursor="true"] {
  box-shadow: inset 4px 0 0 0 var(--primary);
  background: color-mix(in oklch, var(--primary) 10%, transparent);
}
```

- Switches from `--accent` (plum) to `--primary` (amber). Amber is the brand "attention" color; the cursor IS the user's focus, so it should match.
- Bumps the rail from 3px → 4px and tint 8% → 10% — more visible without becoming noisy.

### 2. Inline keyboard shortcut hint

Add a small caption row directly below the toolbar (above the table):

```tsx
<p className="reviewInboxShortcutsHint" aria-hidden="true">
  <kbd>j</kbd>/<kbd>k</kbd> navigate · <kbd>space</kbd> select ·{' '}
  <kbd>c</kbd> category · <kbd>Enter</kbd> apply · <kbd>?</kbd> help
</p>
```

CSS:

```css
.reviewInboxShortcutsHint {
  @apply mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs;
  color: var(--muted-foreground);
}
.reviewInboxShortcutsHint kbd {
  @apply inline-flex min-w-5 items-center justify-center rounded border px-1 font-mono text-[0.7rem];
  border-color: var(--border);
  background: var(--muted);
  color: var(--foreground);
}
```

The existing Shortcuts button (in the toolbar) stays — keeps the full list one click away. The inline hint just covers the daily-driver keys.

### 3. "Why?" button cleanup

**Today** (~line 625-639): inline `style={{ background: 'none', border: 'none', padding: 0, ... }}` on a button.

**After**: extract to a class.

```tsx
<button
  type="button"
  className="reviewInboxHintLink"
  onClick={() => setSignalsDialogTxnId(row.id)}
>
  Why?
</button>
```

```css
.reviewInboxHintLink {
  @apply text-xs;
  background: none;
  border: none;
  padding: 0;
  text-decoration: underline;
  color: var(--muted-foreground);
  cursor: pointer;
}
.reviewInboxHintLink:hover { color: var(--primary); }
.reviewInboxHintLink:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
```

### 4. Decision card visual lift

Mirror the bento hero pattern — subtle amber gradient at the top edge of the decision card.

```css
.reviewInboxDecisionCard {
  background:
    linear-gradient(180deg,
      color-mix(in oklch, var(--primary) 6%, transparent),
      transparent 28%),
    var(--card);
}
```

Pulls the eye to the right pane without a heavy border or new chrome. The `.reviewInboxDecisionCard` selector already exists (currently just `@apply mb-0`); this extends it.

### 5. Legacy token migration in `.reviewInbox*` CSS

Replace pre-Honey-&-Ink aliases with canonical tokens. Behavior unchanged (aliases already point at the new tokens) — but the canonical names make the next migration sweep simpler.

| Old | New | Where |
|---|---|---|
| `var(--accent-green)` | `var(--positive)` | `.reviewInboxMessage` (border + bg + color) |
| `var(--bg3)` | `var(--muted)` | `.reviewInboxTable thead th`, `.reviewInboxPreview div`, `.reviewInboxGuardrail` |
| `var(--bg2)` | `var(--card)` | `.reviewInboxDecisionFields select`, `.reviewInboxToolbar select` |
| `var(--muted)` | `var(--muted-foreground)` | `.reviewInboxHint` |
| `var(--fg)` | `var(--foreground)` | `.reviewInboxDecisionFields select`, `.reviewInboxToolbar select` |

---

## Migration / verification

- One PR. Touches `frontend/src/pages/ReviewInboxPage.tsx` (drop two inline `style` blocks + add the shortcut hint JSX + class swaps) and `frontend/src/App.css` (5 new/updated selectors).
- No new components, no new state, no API changes.
- Verification: `yarn lint`, `tsc -b`, vitest (43 tests), `vite build` — all clean.
- Manual: load `/review`, confirm cursor row is more visible, j/k still navigate, shortcuts hint reads correctly, "Why?" button still opens the signals dialog, decision card shows the subtle amber lift, theme toggle still flips everything cleanly.

## Out of scope (Wave 2.x or later)

- Add bento summary tiles above the queue (user explicitly skipped this).
- Restructure two-pane to bottom-dock decision panel (user skipped).
- Add new keyboard shortcuts beyond the existing 8.
- Pre-fill the decision panel from the cursor row's last rule.
