# Extract TableCard Primitive Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. cashflow-ui-sweep Mode-B (extract a repeated pattern into a primitive).

**Goal:** Extract the sticky-scrollable card-wrapped table pattern — the `.transactions*` quartet (`transactionsTableCard` + `transactionsPanelHeader` + `transactionsTableWrap` + `transactionsTable` sticky thead), borrowed by 5 files (TransactionsPage, PortfolioPage, PortfolioSecurityPage, RulesPage, portfolio-account-type/BucketBreakdownTable) — into reusable primitives. Unblocks the Portfolio cohort + kills the biggest cross-page coupling.

**Architecture:** Two pieces. (1) Enhance the existing `Table` primitive with `maxHeight` (vertical-scroll cap) + `stickyHeader` (sticky thead). (2) A `TableCard` composite = `Card` + optional `SectionHeader` + a sticky `Table`. Card + SectionHeader already exist; the new reusable bit is the sticky-scroll Table region.

## Quartet → primitive mapping (real App.css rules)
- `.transactionsTableCard` = `mb-0` (card variant) → `Card` (TableCard supplies `mb-4`).
- `.transactionsPanelHeader` = `mb-4 flex flex-wrap items-start justify-between gap-3` + `h2{mt-0 mb-1}` → identical to `SectionHeader`.
- `.transactionsTableWrap` = `overflow-auto; max-height:72vh` → Table `maxHeight` prop.
- `.transactionsTable thead th` = `sticky top-0 z-10` → Table `stickyHeader` prop (add an opaque `bg-card` on the sticky th so rows don't bleed through — the old rule relied on table bg; make it explicit).

## Global Constraints
- Worktree `/Users/connoradams/Developer/cashflow/.claude/worktrees/extract-table-card` (node_modules symlinked). Commit `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …` (or `--file`). Sole author, no Co-Authored-By. Token-only. **Run `yarn workspace frontend run build` before pushing** (vitest doesn't typecheck).

---

### Task 1: Enhance `Table` primitive (maxHeight + stickyHeader) — TDD

**Files:** Modify `frontend/src/components/ui/table.tsx`; create `frontend/src/components/ui/table.test.tsx` (if none).

Current `Table` renders `<div data-slot="table-container" class="relative w-full overflow-x-auto"><table data-slot="table" class="w-full caption-bottom text-sm">`. Add optional props:
```tsx
type TableProps = React.ComponentProps<'table'> & {
  maxHeight?: string      // e.g. '72vh' — applied to the container as inline maxHeight + overflow-auto
  stickyHeader?: boolean  // sticky thead th
}
```
- When `maxHeight` set: container gets `style={{ maxHeight }}` + `overflow-auto` (not just `overflow-x-auto`). (Inline style for the free value — established pattern, like Grid.)
- When `stickyHeader`: add to the `<table>` className `[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-card` (the `bg-card` makes the sticky header opaque).
- Backward compatible: no props → identical to today (overflow-x-auto, no sticky).

TDD test: render `<Table maxHeight="72vh" stickyHeader>` → container has `overflow-auto` + inline `max-height:72vh`; table className contains the sticky-thead utilities. Render `<Table>` (no props) → container still `overflow-x-auto`, no sticky classes. Commit `feat(ui): Table supports maxHeight + stickyHeader (sticky scroll)`.

---

### Task 2: `TableCard` composite + gallery — TDD

**Files:** Create `frontend/src/components/ui/table-card.tsx` + `table-card.test.tsx`; modify `DesignSystemSection.tsx` (add a group).

```tsx
type TableCardProps = {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  maxHeight?: string        // default '72vh'
  stickyHeader?: boolean    // default true
  className?: string        // on the Card
  'aria-label'?: string
  children: React.ReactNode // TableHeader + TableBody
}
```
Renders:
```tsx
<Card data-slot="table-card" className={cn('mb-4', className)} aria-label={ariaLabel}>
  {title || description || actions ? (
    <SectionHeader title={title ?? ''} description={description} actions={actions} />
  ) : null}
  <Table maxHeight={maxHeight ?? '72vh'} stickyHeader={stickyHeader ?? true}>{children}</Table>
</Card>
```
(SectionHeader requires `title`; only render the header when there's title/description/actions. If only actions/description without title, pass `title={title ?? null}` — confirm SectionHeader renders fine with an empty/absent title, else guard.)

TDD test: `<TableCard title="Holdings" actions={<Badge variant="count">5</Badge>}><TableHeader>…</TableHeader><TableBody>…</TableBody></TableCard>` → renders an h2 "Holdings" (SectionHeader), the badge, a `data-slot="table-card"`, and the table with sticky/maxHeight (via Table). A `<TableCard>` with no title renders no SectionHeader. Commit `feat(ui): add TableCard primitive (card + header + sticky table) + gallery`.

Gallery: add a `<Group name="Table card">` rendering a small `<TableCard title="Example" actions={<Badge variant="count">3</Badge>}>` with 2-3 rows. Don't rename existing groups.

---

### Task 3: Adopt on BucketBreakdownTable (validation)

**Files:** Modify `frontend/src/pages/portfolio-account-type/BucketBreakdownTable.tsx` (smallest quartet consumer).

Replace its `<… className="transactionsTableCard"> / transactionsPanelHeader / <div className="transactionsTableWrap"><table className="table transactionsTable">` structure with `<TableCard title=… actions=…>{TableHeader+TableBody}</TableCard>` (+ `Table*` primitives for the rows if it used raw `<table>`). Look-preserving: TableCard gives Card surface + SectionHeader + sticky 72vh table — matching the quartet. Drop the borrowed `.transactions*` classes from this file.
> Do NOT delete the App.css quartet rules yet — 4 other files still consume them (Transactions/Portfolio/PortfolioSecurity/Rules). The teardown happens once all adopt TableCard.
Run any existing test + `yarn workspace frontend run build`. Commit `refactor(ui): BucketBreakdownTable adopts TableCard`.

---

### Task 4: Verify + ship
`yarn workspace frontend run test table table-card DesignSystemSection` + the portfolio-account-type tests if any; `yarn workspace frontend run build` clean; `yarn workspace frontend run lint`; broad `yarn workspace frontend run test --run`. Push, PR, auto-merge.

## Self-Review
- Extracts the genuinely-missing reusable bit (sticky-scroll Table) + the ergonomic composite (TableCard). Card/SectionHeader reused. ✓
- Validated by adopting on the smallest consumer; Portfolio/PortfolioSecurity/Transactions/Rules adopt in their own (now-unblocked) sweeps; App.css quartet stays until all migrate (logged). ✓
- Build-check in DoD (the type-error gap). ✓
- Risk: the sticky-th `bg-card` is an explicit improvement over the old implicit bg — verify it looks right (opaque header on scroll) in the gallery/build.
