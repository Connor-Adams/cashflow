# design-sync notes — @cashflow/ui

Repo-specific gotchas for future syncs of `@cashflow/ui` (packages/ui) → claude.ai/design.

## Setup / build
- Shape: **package** (no Storybook). Pinned in `design-sync.config.json` (`shape: package`).
- Faithful install: run `corepack yarn install` **inside the worktree** (yarn 4 berry; worktree gets its own node_modules). A PreToolUse hook warns plain `yarn install` under `.claude/worktrees` can fail (vite-link) — the `corepack` form worked here.
- Build the DS package before the converter: `corepack yarn workspace @cashflow/ui run build` (tsup ESM + tailwindcss v4 CLI). Emits `packages/ui/dist/{index.js,index.d.ts,cashflow-ui.css}`.
- Converter entry: `--entry ./packages/ui/dist/index.js`, `--node-modules ./node_modules` (react resolves at worktree root; node-modules linker, no `packages/ui/node_modules`).
- `cssEntry: dist/cashflow-ui.css` (package-relative — cfgPath resolves against PKG_DIR=packages/ui). This is the compiled self-contained stylesheet (README "Option A").

## Discovery / grouping decisions
- Barrel exports **33 PascalCase symbols** = 14 logical components + 19 compound sub-parts.
- We **exclude the 19 sub-parts** from separate cards via `componentSrcMap: {<Sub>: null}` (CardHeader/Title/Description/Content, Dialog{Header,Title,Description,Body,Footer}, Skeleton{Text,Row}, EmptyTableRow, NativeSelectOption, Table{Header,Body,Head,Row,Cell}, TabPanel). They stay importable in `_ds_bundle.js` (`window.CashflowUI.CardHeader` works) and are documented inside their parent's authored preview/prompt. Keeps the DS pane to the 14 real primitives.
- **Groups** set via frontmatter-only stub docs in `.design-sync/groups/<Name>.md` (`category:` line), mapped through `cfg.docsMap` with **`../../` prefix** (docsMap paths resolve relative to packages/ui, bounded to the git workspace root). Empty body → synthesized prompt is preserved (includes authored preview examples). Groups: Actions(Button) · Forms(Input,Label,NativeSelect,Textarea) · Feedback(Alert,Badge,EmptyState,Skeleton) · Layout(Card,Grid) · Data(Table,Tabs) · Overlay(Dialog).

## Fonts / CSS
- No custom `@font-face` and no `font-family` declarations in the DS CSS — uses system/default font stack. No `[FONT_MISSING]` expected.
- No `lucide-react` imports inside components (it's a peer dep but unused in src) — no icon-bundle (`extraEntries`) needed.

## Verification mode
- Render check (Playwright + Chromium ~200MB) **NOT installed** — Connor chose human review ("I'll eyeball"). Run `package-validate.mjs --no-render-check` for the mechanical/structural gate; grading is via Connor's review of `ds-bundle/.review.html`, not machine screenshots. `package-capture.mjs` screenshots are unavailable for the same reason.
- globalName pinned `CashflowUI` (default derivation would give `CashflowUi`).

## Brand context for previews (from packages/ui/README.md)
- Oxblood `#9B2D3A` = signature / CTA / money-out / danger. Green = money-in / positive. Zinc greyscale = workhorse surfaces/text.
- Dark mode via `data-theme="dark"` on root.
- Use realistic money/finance content in previews (transactions, balances), never foo/bar.

## Target project (IMPORTANT)
- Synced to a **dedicated** project **"Cashflow UI — @cashflow/ui"** (`projectId 2ee5e2a0-95f0-44d4-a428-a93ae5c818f1`), pinned in config. Re-syncs go here automatically.
- Do **NOT** sync to the pre-existing **"Cashflow Design System"** (`2cf89db3-0935-4512-b99a-1ea651de503d`) — that's a separate, hand-built DS (foundations pages, brand assets, full app ui_kit screens, custom component grouping) with a different layout. The converter output would overwrite/duplicate it. Connor chose a new project to keep that one untouched (2026-06-19).

## Re-sync risks
- Previews compose sub-parts (CardHeader etc.) that are excluded as standalone cards; if a sub-part is renamed/removed upstream, the parent preview breaks silently — rebuild + eyeball after any DS API change.
- Group stubs are tied to the current 14-component set; a new primitive needs a new `.design-sync/groups/<Name>.md` + docsMap entry or it lands in `general`.
- No machine render check ran — renders verified by human eyeball only on the sync date; a future headless re-sync has no screenshot baseline.
