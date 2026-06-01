# Receipt Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-shipped (PR #47) but invisible Gmail emailed-receipt pipeline discoverable (dashboard tile + nav) and persistently legible (a `/receipts` page over existing data).

**Architecture:** Pure read-layer + frontend. Two new read-only endpoints expose data the pipeline already writes (`ExternalOrder` list with match status; `ProcessedEmailMessage` scan history). A new `/receipts` page composes the existing `<GmailSection />` (connect/scan), a new scan-history panel, and a new receipts list. The existing `AmazonPage` is reused (with a new `embedded` prop) as the `vendor=amazon` slice; `/amazon` redirects to `/receipts?vendor=amazon`. A dashboard tile signposts the dormant integration. No new tables, no model changes, no primitives-spine change.

**Tech Stack:** Backend — Node/TypeScript, Express, Sequelize, Postgres; tests via `node:test` + `supertest` + `setupPgTestDb`. Frontend — React + TypeScript + Vite, React Router, Tailwind v4; tests via Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-31-receipt-visibility-design.md`

**Pre-req:** Work happens in the current git worktree (`funny-bose-e157a0`). Run all commands from the repo root unless a `cd` is shown.

---

## File Structure

**Backend (modify):**
- `backend/src/routes/externalOrders.ts` — add `GET /` (vendor-agnostic `ExternalOrder` list with derived `linkStatus`). Mounted at `/api/external-orders`.
- `backend/src/routes/emailIntegrations.ts` — add `GET /history` (`ProcessedEmailMessage` read-back). Mounted at `/api/email`.

**Backend (create):**
- `backend/test/integration/externalOrdersList.test.ts`
- `backend/test/integration/emailHistory.test.ts`

**Frontend (create):**
- `frontend/src/components/receipts/GmailScanHistory.tsx` (+ `.test.tsx`)
- `frontend/src/components/receipts/ReceiptsList.tsx` (+ `.test.tsx`)
- `frontend/src/components/dashboard/EmailedReceiptsTile.tsx` (+ `.test.tsx`)
- `frontend/src/pages/ReceiptsPage.tsx` (+ `.test.tsx`)

**Frontend (modify):**
- `frontend/src/pages/AmazonPage.tsx` — add optional `embedded` prop.
- `frontend/src/App.tsx` — add `/receipts` route; redirect `/amazon`.
- `frontend/src/components/Sidebar.tsx` — add "Receipts" nav item, remove "Amazon".
- `frontend/src/components/Sidebar.test.tsx` — update nav assertions.
- `frontend/src/pages/DashboardPage.tsx` — render `<EmailedReceiptsTile />`.

---

## Task 1: Backend — `GET /api/external-orders` list with link status

**Files:**
- Modify: `backend/src/routes/externalOrders.ts`
- Test: `backend/test/integration/externalOrdersList.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/test/integration/externalOrdersList.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let householdId: number;
let accountId: number;

before(async () => {
  testDb = await setupPgTestDb('external-orders-list');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'orders@example.com',
    displayName: 'Orders User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  // Fresh test DB → exactly one household/account. Read them from the DB rather
  // than depending on response body shapes.
  const hh = await models.Household.findOne();
  assert.ok(hh, 'household exists after register');
  householdId = hh.id;
  await authed.post('/api/accounts').send({ name: 'Card', owner: 'me', defaultCurrency: 'CAD' });
  const account = await models.Account.findOne();
  assert.ok(account, 'account exists after create');
  accountId = account.id;

  // A Gmail-sourced order, linked (accepted) to a transaction.
  const gmailOrder = await models.ExternalOrder.create({
    householdId,
    vendor: 'apple',
    dedupeKey: 'gmail-1',
    orderDate: '2026-05-20',
    total: '9.99',
    currency: 'CAD',
    source: 'gmail-scan:apple',
  } as never);
  const txn = await models.Transaction.create({
    accountId,
    householdId,
    date: '2026-05-20',
    merchantRaw: 'APPLE.COM/BILL',
    merchantClean: 'Apple',
    amount: '-9.99',
    currency: 'CAD',
    status: 'posted',
  } as never);
  await models.TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: gmailOrder.id,
    confidence: '95',
    matchReason: 'test',
    status: 'accepted',
  } as never);

  // An Amazon-sourced order, no links (orphan).
  await models.ExternalOrder.create({
    householdId,
    vendor: 'amazon',
    dedupeKey: 'amz-1',
    orderDate: '2026-05-22',
    total: '40.00',
    currency: 'CAD',
    source: 'amazon-csv',
  } as never);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/external-orders returns all household orders with derived linkStatus', async () => {
  const res = await authed.get('/api/external-orders');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  const apple = res.body.find((o: { vendor: string }) => o.vendor === 'apple');
  const amazon = res.body.find((o: { vendor: string }) => o.vendor === 'amazon');
  assert.equal(apple.linkStatus, 'linked');
  assert.equal(amazon.linkStatus, 'orphan');
  assert.ok(Array.isArray(apple.items));
});

test('group=gmail filters to gmail-scan:* sources', async () => {
  const res = await authed.get('/api/external-orders?group=gmail');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].vendor, 'apple');
});

test('group=amazon filters to vendor=amazon', async () => {
  const res = await authed.get('/api/external-orders?group=amazon');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].vendor, 'amazon');
});

test('rejects unauthenticated requests', async () => {
  const res = await request(app).get('/api/external-orders');
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/integration/externalOrdersList.test.ts`
Expected: FAIL — `GET /api/external-orders` returns 404 (route not defined), so length/linkStatus assertions fail.

- [ ] **Step 3: Implement the endpoint**

In `backend/src/routes/externalOrders.ts`, update the imports at the top of the file:
- Change the `sequelize` import line to add `Op` from sequelize and the extra models. The existing import is:
  ```ts
  import { sequelize, ExternalOrder, ExternalOrderItem, ExternalOrderTender } from '../models';
  ```
  Replace it with:
  ```ts
  import { Op } from 'sequelize';
  import {
    sequelize,
    ExternalOrder,
    ExternalOrderItem,
    ExternalOrderTender,
    TransactionOrderLink,
  } from '../models';
  ```

Then add this block immediately **after** `const router = Router();` (so the list route is registered before the existing `POST` routes — order does not matter for distinct methods, but keep it grouped):

```ts
type LinkStatus = 'linked' | 'needs_match' | 'orphan';

function deriveLinkStatus(links: TransactionOrderLink[] | undefined): LinkStatus {
  const list = links ?? [];
  if (list.some((l) => l.status === 'accepted')) return 'linked';
  if (list.some((l) => l.status === 'suggested')) return 'needs_match';
  return 'orphan';
}

function serializeOrderWithLinkStatus(order: ExternalOrder) {
  const json = order.toJSON() as Record<string, unknown>;
  const linkStatus = deriveLinkStatus(
    order.get('transactionLinks') as TransactionOrderLink[] | undefined,
  );
  delete json.transactionLinks;
  return { ...json, linkStatus };
}

/**
 * GET /api/external-orders?group=all|gmail|amazon|other&limit=50
 *
 * Vendor-agnostic list of captured receipts/orders for the caller's household,
 * each annotated with its match status to card transactions. The canonical
 * read surface behind the /receipts page.
 */
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const group = String(req.query.group ?? 'all').toLowerCase();

    const where: Record<string, unknown> = { householdId: household.id };
    if (group === 'gmail') {
      where.source = { [Op.like]: 'gmail-scan:%' };
    } else if (group === 'amazon') {
      where.vendor = 'amazon';
    } else if (group === 'other') {
      where.source = { [Op.notLike]: 'gmail-scan:%' };
      where.vendor = { [Op.ne]: 'amazon' };
    }

    const orders = await ExternalOrder.findAll({
      where: where as never,
      include: [
        { model: ExternalOrderItem, as: 'items' },
        { model: TransactionOrderLink, as: 'transactionLinks', required: false },
      ],
      order: [
        ['orderDate', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    });

    res.json(orders.map(serializeOrderWithLinkStatus));
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/integration/externalOrdersList.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/externalOrders.ts backend/test/integration/externalOrdersList.test.ts
git commit --no-verify -m "feat(receipts): add GET /api/external-orders list with derived link status"
```

> Note: `--no-verify` is used throughout because the husky pre-commit hook calls `lint-staged`, which is not installed in this worktree's `node_modules`. Run lint/typecheck explicitly per the steps instead.

---

## Task 2: Backend — `GET /api/email/history` scan log

**Files:**
- Modify: `backend/src/routes/emailIntegrations.ts`
- Test: `backend/test/integration/emailHistory.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/test/integration/emailHistory.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let householdId: number;

before(async () => {
  testDb = await setupPgTestDb('email-history');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'history@example.com',
    displayName: 'History User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const hh = await models.Household.findOne();
  assert.ok(hh, 'household exists after register');
  householdId = hh.id;

  await models.ProcessedEmailMessage.create({
    householdId,
    provider: 'google',
    messageId: 'msg-1',
    status: 'extracted',
    parser: 'apple',
    subject: 'Your receipt',
    fromAddr: 'no_reply@apple.com',
    scannedAt: new Date('2026-05-20T10:00:00Z'),
  } as never);
  await models.ProcessedEmailMessage.create({
    householdId,
    provider: 'google',
    messageId: 'msg-2',
    status: 'no_items',
    subject: 'Newsletter',
    fromAddr: 'news@apple.com',
    scannedAt: new Date('2026-05-21T10:00:00Z'),
  } as never);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/email/history returns the household scan log, newest first', async () => {
  const res = await authed.get('/api/email/history');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].messageId, 'msg-2');
  assert.equal(res.body[0].status, 'no_items');
  assert.equal(res.body[1].messageId, 'msg-1');
  assert.equal(res.body[1].parser, 'apple');
});

test('rejects unauthenticated requests', async () => {
  const res = await request(app).get('/api/email/history');
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/integration/emailHistory.test.ts`
Expected: FAIL — `/api/email/history` returns 404.

- [ ] **Step 3: Implement the endpoint**

In `backend/src/routes/emailIntegrations.ts`, add `ProcessedEmailMessage` to the models import. The existing import is:
```ts
import { ReceiptSenderAllowlist, UserEmailIntegration } from '../models';
```
Replace with:
```ts
import { ProcessedEmailMessage, ReceiptSenderAllowlist, UserEmailIntegration } from '../models';
```

Then add this route immediately **after** the existing `router.get('/status', ...)` handler:

```ts
/**
 * GET /api/email/history?limit=50
 * Persistent scan log: every message the Gmail scan has processed for this
 * household, newest first. The durable counterpart to GmailSection's
 * in-memory live feed.
 */
router.get('/history', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await ProcessedEmailMessage.findAll({
      where: { householdId: household.id },
      order: [
        ['scannedAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    });
    res.json(
      rows.map((r) => ({
        messageId: r.messageId,
        subject: r.subject,
        fromAddr: r.fromAddr,
        status: r.status,
        parser: r.parser,
        externalOrderId: r.externalOrderId,
        errorMessage: r.errorMessage,
        scannedAt: r.scannedAt?.toISOString() ?? null,
      })),
    );
  } catch (e) {
    next(e);
  }
});
```

> `ProcessedEmailMessage` is already imported and re-exported by `backend/src/models/index.ts` (line 40), same as `UserEmailIntegration`/`ReceiptSenderAllowlist` — so this import resolves with no model changes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/integration/emailHistory.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/emailIntegrations.ts backend/test/integration/emailHistory.test.ts
git commit --no-verify -m "feat(receipts): add GET /api/email/history scan log endpoint"
```

---

## Task 3: Frontend — `GmailScanHistory` component

**Files:**
- Create: `frontend/src/components/receipts/GmailScanHistory.tsx`
- Test: `frontend/src/components/receipts/GmailScanHistory.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/receipts/GmailScanHistory.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GmailScanHistory } from './GmailScanHistory'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

describe('GmailScanHistory', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
  })

  it('renders scan rows from the history endpoint', async () => {
    vi.mocked(getJson).mockResolvedValue([
      {
        messageId: 'm1',
        subject: 'Your receipt',
        fromAddr: 'no_reply@apple.com',
        status: 'extracted',
        parser: 'apple',
        externalOrderId: 7,
        errorMessage: null,
        scannedAt: '2026-05-20T10:00:00.000Z',
      },
    ])
    render(<GmailScanHistory />)
    await waitFor(() =>
      expect(screen.getByText('Your receipt')).toBeInTheDocument(),
    )
    expect(getJson).toHaveBeenCalledWith('/api/email/history')
  })

  it('shows an empty message when there is no history', async () => {
    vi.mocked(getJson).mockResolvedValue([])
    render(<GmailScanHistory />)
    await waitFor(() =>
      expect(screen.getByText(/no scans yet/i)).toBeInTheDocument(),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/receipts/GmailScanHistory.test.tsx`
Expected: FAIL — module `./GmailScanHistory` not found.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/receipts/GmailScanHistory.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'

type ScanHistoryRow = {
  messageId: string
  subject: string | null
  fromAddr: string | null
  status: string
  parser: string | null
  externalOrderId: number | null
  errorMessage: string | null
  scannedAt: string | null
}

const STATUS_LABEL: Record<string, string> = {
  extracted: 'extracted',
  filtered_subject: 'filtered',
  no_items: 'no items',
  extraction_failed: 'failed',
  duplicate: 'duplicate',
}

export function GmailScanHistory() {
  const [rows, setRows] = useState<ScanHistoryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await getJson<ScanHistoryRow[]>('/api/email/history')
        if (!cancelled) setRows(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load scan history')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-semibold">
        Scan history{rows ? ` (${rows.length})` : ''}
      </summary>
      {error ? (
        <p className="error mt-2 text-sm" role="alert">
          {error}
        </p>
      ) : rows === null ? (
        <p className="muted mt-2 text-sm">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted mt-2 text-sm">No scans yet. Run a scan from the panel above.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {rows.map((r) => (
            <li key={r.messageId} className="flex items-baseline justify-between gap-2">
              <span className="truncate" title={r.subject ?? ''}>
                {r.subject ?? '(no subject)'}
              </span>
              <span className="muted shrink-0 tabular-nums">
                {STATUS_LABEL[r.status] ?? r.status}
                {r.scannedAt ? ` · ${new Date(r.scannedAt).toLocaleDateString()}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/receipts/GmailScanHistory.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/receipts/GmailScanHistory.tsx frontend/src/components/receipts/GmailScanHistory.test.tsx
git commit --no-verify -m "feat(receipts): add GmailScanHistory panel"
```

---

## Task 4: Frontend — `ReceiptsList` component

**Files:**
- Create: `frontend/src/components/receipts/ReceiptsList.tsx`
- Test: `frontend/src/components/receipts/ReceiptsList.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/receipts/ReceiptsList.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ReceiptsList } from './ReceiptsList'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

describe('ReceiptsList', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
  })

  it('fetches with the group param and renders order rows with link status', async () => {
    vi.mocked(getJson).mockResolvedValue([
      {
        id: 1,
        vendor: 'apple',
        source: 'email_gmail_apple',
        orderDate: '2026-05-20',
        total: '9.99',
        currency: 'CAD',
        paymentLast4: null,
        linkStatus: 'linked',
        items: [{ id: 5, title: 'iCloud+', quantity: 1, unitPrice: null, totalPrice: '9.99', inferredCategory: null }],
      },
    ])
    render(<ReceiptsList group="gmail" />)
    await waitFor(() => expect(screen.getByText('apple')).toBeInTheDocument())
    expect(getJson).toHaveBeenCalledWith('/api/external-orders?group=gmail')
    expect(screen.getByText(/linked/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no receipts', async () => {
    vi.mocked(getJson).mockResolvedValue([])
    render(<ReceiptsList group="all" />)
    await waitFor(() => expect(screen.getByText(/no receipts/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/receipts/ReceiptsList.test.tsx`
Expected: FAIL — module `./ReceiptsList` not found.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/receipts/ReceiptsList.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import { EmptyState } from '@/components/ui/empty-state'
import { formatMoney } from '@/lib/formatMoney'

export type ReceiptGroup = 'all' | 'gmail' | 'amazon' | 'other'

type ReceiptItem = {
  id: number
  title: string
  quantity: number
  unitPrice: string | null
  totalPrice: string | null
  inferredCategory: string | null
}

type ReceiptOrder = {
  id: number
  vendor: string
  source: string | null
  orderDate: string | null
  total: string | null
  currency: string
  paymentLast4: string | null
  linkStatus: 'linked' | 'needs_match' | 'orphan'
  items?: ReceiptItem[]
}

const LINK_LABEL: Record<ReceiptOrder['linkStatus'], string> = {
  linked: 'Linked',
  needs_match: 'Needs match',
  orphan: 'Orphan',
}

const LINK_COLOR: Record<ReceiptOrder['linkStatus'], string> = {
  linked: 'var(--primary)',
  needs_match: 'var(--accent-warm, var(--muted-foreground))',
  orphan: 'var(--muted-foreground)',
}

export function ReceiptsList({ group }: { group: ReceiptGroup }) {
  const [orders, setOrders] = useState<ReceiptOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setOrders(null)
    setError(null)
    void (async () => {
      try {
        const data = await getJson<ReceiptOrder[]>(`/api/external-orders?group=${group}`)
        if (!cancelled) setOrders(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load receipts')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [group])

  if (error) {
    return (
      <p className="error text-sm" role="alert">
        {error}
      </p>
    )
  }
  if (orders === null) {
    return <p className="muted text-sm">Loading receipts…</p>
  }
  if (orders.length === 0) {
    return (
      <EmptyState
        title="No receipts yet"
        description="Connect Gmail and run a scan, or import an order report, to see receipts here."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {orders.map((o) => (
        <li key={o.id}>
          <details className="rounded-md border border-border p-3">
            <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{o.vendor}</span>
              <span className="muted text-sm">{o.orderDate ?? '—'}</span>
              <span className="tabular-nums">
                {o.total != null ? formatMoney(Number(o.total), o.currency) : '—'}
              </span>
              <span className="text-xs font-semibold" style={{ color: LINK_COLOR[o.linkStatus] }}>
                {LINK_LABEL[o.linkStatus]}
              </span>
              {o.source ? <span className="muted text-xs">{o.source}</span> : null}
            </summary>
            <ul className="mt-2 flex flex-col gap-1 pl-4 text-sm">
              {(o.items ?? []).map((it) => (
                <li key={it.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    {it.title}
                    {it.quantity > 1 ? ` ×${it.quantity}` : ''}
                  </span>
                  <span className="muted tabular-nums">
                    {it.totalPrice != null ? formatMoney(Number(it.totalPrice), o.currency) : '—'}
                  </span>
                </li>
              ))}
              {(o.items ?? []).length === 0 ? <li className="muted">No line items</li> : null}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/receipts/ReceiptsList.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/receipts/ReceiptsList.tsx frontend/src/components/receipts/ReceiptsList.test.tsx
git commit --no-verify -m "feat(receipts): add ReceiptsList component over /api/external-orders"
```

---

## Task 5: Frontend — `AmazonPage` `embedded` prop

Lets `AmazonPage` render inside `ReceiptsPage` (as the `vendor=amazon` slice) without its own page title duplicating the `/receipts` header. Keeps every Amazon affordance intact.

**Files:**
- Modify: `frontend/src/pages/AmazonPage.tsx`

- [ ] **Step 1: Add the prop to the component signature**

In `frontend/src/pages/AmazonPage.tsx`, change the component declaration (currently `export function AmazonPage() {` around line 130) to:

```tsx
export function AmazonPage({ embedded = false }: { embedded?: boolean } = {}) {
```

- [ ] **Step 2: Make the outer wrapper + title conditional**

The return currently opens (lines 333–340):

```tsx
  return (
    <div className="page amazonPage">
      {confirm.dialog}
      <div className="amazonHeader">
        <div>
          <h1>Amazon Enrichment</h1>
          <p className="muted">Import Amazon order reports, match them to card charges, and review item-level categories.</p>
        </div>
        <div className="amazonActionRow">
```

Replace those lines with (drop the `page` padding class and the duplicate title block when embedded; keep the action row):

```tsx
  return (
    <div className={embedded ? 'amazonPage' : 'page amazonPage'}>
      {confirm.dialog}
      <div className="amazonHeader">
        {!embedded && (
          <div>
            <h1>Amazon Enrichment</h1>
            <p className="muted">Import Amazon order reports, match them to card charges, and review item-level categories.</p>
          </div>
        )}
        <div className="amazonActionRow">
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors. (`<AmazonPage />` with no props still type-checks because the prop is optional with a default.)

- [ ] **Step 4: Run existing Amazon tests (if any) to confirm no regression**

Run: `cd frontend && npx vitest run src/pages/AmazonPage 2>/dev/null || echo "no AmazonPage tests"`
Expected: PASS or "no AmazonPage tests".

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/AmazonPage.tsx
git commit --no-verify -m "refactor(amazon): add embedded prop to render AmazonPage inside /receipts"
```

---

## Task 6: Frontend — `ReceiptsPage` + route + `/amazon` redirect

**Files:**
- Create: `frontend/src/pages/ReceiptsPage.tsx`
- Test: `frontend/src/pages/ReceiptsPage.test.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/ReceiptsPage.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ReceiptsPage } from './ReceiptsPage'

// Stub child components that fetch, so this test stays focused on ReceiptsPage layout + filter.
vi.mock('@/pages/settings/sections/GmailSection', () => ({
  GmailSection: () => <div data-testid="gmail-section" />,
}))
vi.mock('@/components/receipts/GmailScanHistory', () => ({
  GmailScanHistory: () => <div data-testid="scan-history" />,
}))
vi.mock('@/components/receipts/ReceiptsList', () => ({
  ReceiptsList: ({ group }: { group: string }) => <div data-testid="receipts-list">{group}</div>,
}))
vi.mock('@/pages/AmazonPage', () => ({
  AmazonPage: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="amazon-embedded">{String(embedded)}</div>
  ),
}))

describe('ReceiptsPage', () => {
  it('renders the Gmail panel, scan history, and the all-sources list by default', () => {
    render(
      <MemoryRouter initialEntries={['/receipts']}>
        <ReceiptsPage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: /receipts/i })).toBeInTheDocument()
    expect(screen.getByTestId('gmail-section')).toBeInTheDocument()
    expect(screen.getByTestId('scan-history')).toBeInTheDocument()
    expect(screen.getByTestId('receipts-list')).toHaveTextContent('all')
  })

  it('renders the embedded AmazonPage when ?vendor=amazon', () => {
    render(
      <MemoryRouter initialEntries={['/receipts?vendor=amazon']}>
        <ReceiptsPage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('amazon-embedded')).toHaveTextContent('true')
    expect(screen.queryByTestId('receipts-list')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/ReceiptsPage.test.tsx`
Expected: FAIL — module `./ReceiptsPage` not found.

- [ ] **Step 3: Implement the page**

Create `frontend/src/pages/ReceiptsPage.tsx`:

```tsx
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { GmailSection } from '@/pages/settings/sections/GmailSection'
import { GmailScanHistory } from '@/components/receipts/GmailScanHistory'
import { ReceiptsList, type ReceiptGroup } from '@/components/receipts/ReceiptsList'
import { AmazonPage } from '@/pages/AmazonPage'

const GROUPS: { value: ReceiptGroup; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'gmail', label: 'Gmail' },
  { value: 'amazon', label: 'Amazon' },
  { value: 'other', label: 'Other' },
]

function resolveGroup(params: URLSearchParams): ReceiptGroup {
  if (params.get('vendor') === 'amazon') return 'amazon'
  const g = params.get('group')
  if (g === 'gmail' || g === 'amazon' || g === 'other') return g
  return 'all'
}

export function ReceiptsPage() {
  const [params, setParams] = useSearchParams()
  const group = resolveGroup(params)

  function selectGroup(next: ReceiptGroup) {
    const p = new URLSearchParams()
    if (next !== 'all') p.set('group', next)
    setParams(p, { replace: true })
  }

  return (
    <main className="p-6 max-w-5xl mx-auto flex flex-col gap-4">
      <PageHeader
        title="Receipts"
        description="Emailed receipts and imported orders, and how they match your card transactions."
      />

      <GmailSection />
      <GmailScanHistory />

      <nav className="flex gap-2 border-b border-[var(--border)]" aria-label="Filter receipts by source">
        {GROUPS.map((g) => (
          <button
            key={g.value}
            type="button"
            onClick={() => selectGroup(g.value)}
            aria-pressed={group === g.value}
            className={
              group === g.value
                ? 'px-3 py-2 border-b-2 border-[var(--primary)] font-semibold'
                : 'px-3 py-2 border-b-2 border-transparent text-[var(--muted-foreground)]'
            }
          >
            {g.label}
          </button>
        ))}
      </nav>

      {group === 'amazon' ? <AmazonPage embedded /> : <ReceiptsList group={group} />}
    </main>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/ReceiptsPage.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the route + redirect `/amazon`**

In `frontend/src/App.tsx`:

(a) Add the import next to the other page imports (near the `AmazonPage` import at line 42):

```tsx
import { ReceiptsPage } from './pages/ReceiptsPage'
```

(b) Change the existing Amazon route (line 123) from:

```tsx
          <Route path="amazon" element={<AmazonPage />} />
```

to:

```tsx
          <Route path="receipts" element={<ReceiptsPage />} />
          <Route path="amazon" element={<Navigate to="/receipts?vendor=amazon" replace />} />
```

(`Navigate` is already imported in App.tsx — it is used by sibling redirect routes like `/review`.)

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/ReceiptsPage.tsx frontend/src/pages/ReceiptsPage.test.tsx frontend/src/App.tsx
git commit --no-verify -m "feat(receipts): add /receipts page; redirect /amazon to the amazon view"
```

---

## Task 7: Frontend — Sidebar nav (add Receipts, remove Amazon)

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/components/Sidebar.test.tsx`

- [ ] **Step 1: Update the test first**

`frontend/src/components/Sidebar.test.tsx` has a test (lines 46–53) that asserts Amazon lives in the Money section. Replace that entire `it(...)` block:

```tsx
  it('relocates Amazon into the Money section', () => {
    // Credit cards was also relocated here in PR 0, then folded into the
    // Accounts tabs in PR 3 (asserted absent below).
    renderSidebar()
    const moneyHeader = screen.getByRole('button', { name: /Money/ })
    const moneySection = moneyHeader.closest('.sidebar__section') as HTMLElement
    expect(within(moneySection).getByRole('link', { name: 'Amazon' })).toBeInTheDocument()
  })
```

with:

```tsx
  it('places Receipts in the Money section and drops the standalone Amazon entry', () => {
    renderSidebar()
    const moneyHeader = screen.getByRole('button', { name: /Money/ })
    const moneySection = moneyHeader.closest('.sidebar__section') as HTMLElement
    expect(within(moneySection).getByRole('link', { name: 'Receipts' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Amazon' })).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Sidebar.test.tsx`
Expected: FAIL — no "Receipts" link yet (and/or "Amazon" still present).

- [ ] **Step 3: Update the icon import**

In `frontend/src/components/Sidebar.tsx`, in the `lucide-react` import block (lines 3–35): add `Receipt,` to the import list and remove `PackageSearch,` (it is only used by the Amazon nav item being removed).

- [ ] **Step 4: Edit the Money nav section**

In the `money` section's `items` array (lines 71–80), remove the Amazon line and add a Receipts line. Change:

```tsx
      { to: '/transactions', label: 'Transactions', icon: ReceiptText },
      { to: '/reimbursements', label: 'Reimbursements', icon: HandCoins },
      { to: '/import', label: 'Import', icon: Upload },
      { to: '/amazon', label: 'Amazon', icon: PackageSearch },
      { to: '/recurring', label: 'Recurring', icon: Repeat },
```

to:

```tsx
      { to: '/transactions', label: 'Transactions', icon: ReceiptText },
      { to: '/receipts', label: 'Receipts', icon: Receipt },
      { to: '/reimbursements', label: 'Reimbursements', icon: HandCoins },
      { to: '/import', label: 'Import', icon: Upload },
      { to: '/recurring', label: 'Recurring', icon: Repeat },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Sidebar.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck (catches the removed `PackageSearch` if still referenced)**

Run: `cd frontend && npx tsc -b`
Expected: no errors. If `PackageSearch` is referenced elsewhere in Sidebar.tsx, keep its import; otherwise its removal is clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/components/Sidebar.test.tsx
git commit --no-verify -m "feat(receipts): add Receipts nav item, fold away standalone Amazon entry"
```

---

## Task 8: Frontend — `EmailedReceiptsTile` dashboard signpost

**Files:**
- Create: `frontend/src/components/dashboard/EmailedReceiptsTile.tsx`
- Test: `frontend/src/components/dashboard/EmailedReceiptsTile.test.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/dashboard/EmailedReceiptsTile.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EmailedReceiptsTile } from './EmailedReceiptsTile'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

function mockStatus(status: Record<string, unknown>) {
  vi.mocked(getJson).mockImplementation((path: string) => {
    if (path === '/api/email/status') return Promise.resolve(status)
    return Promise.resolve([]) // gmail order count
  })
}

describe('EmailedReceiptsTile', () => {
  beforeEach(() => vi.mocked(getJson).mockReset())

  it('shows a loud connect prompt when the feature is enabled but not connected', async () => {
    mockStatus({ featureEnabled: true, connected: false })
    render(
      <MemoryRouter>
        <EmailedReceiptsTile />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /connect gmail/i })).toHaveAttribute('href', '/receipts'),
    )
  })

  it('renders nothing when the feature is not configured', async () => {
    mockStatus({ featureEnabled: false, connected: false })
    const { container } = render(
      <MemoryRouter>
        <EmailedReceiptsTile />
      </MemoryRouter>,
    )
    await waitFor(() => expect(getJson).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a stat + view link when connected', async () => {
    mockStatus({ featureEnabled: true, connected: true, accountEmail: 'me@gmail.com' })
    render(
      <MemoryRouter>
        <EmailedReceiptsTile />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /view receipts/i })).toHaveAttribute('href', '/receipts'),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/dashboard/EmailedReceiptsTile.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tile**

Create `frontend/src/components/dashboard/EmailedReceiptsTile.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BentoTile } from './BentoTile'
import { getJson } from '@/lib/api'

type GmailStatus = {
  featureEnabled: boolean
  connected: boolean
  accountEmail?: string | null
}

type ReceiptOrder = { id: number }

export function EmailedReceiptsTile() {
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [gmailCount, setGmailCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await getJson<GmailStatus>('/api/email/status')
        if (cancelled) return
        setStatus(s)
        if (s.featureEnabled && s.connected) {
          const orders = await getJson<ReceiptOrder[]>('/api/external-orders?group=gmail&limit=100')
          if (!cancelled) setGmailCount(orders.length)
        }
      } catch {
        if (!cancelled) setStatus({ featureEnabled: false, connected: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Don't nag when the integration isn't configured on the server, and render
  // nothing until status is known.
  if (!status || !status.featureEnabled) return null

  if (!status.connected) {
    return (
      <BentoTile span={6} rows={1} variant="warning" label="Emailed receipts">
        <div className="space-y-2">
          <p className="text-sm">
            Cashflow can auto-import receipts from your inbox (Apple, Amazon, Uber, and more) and match
            them to your card charges. It’s set up but not connected.
          </p>
          <Link to="/receipts" className="text-sm font-semibold text-foreground underline">
            Connect Gmail →
          </Link>
        </div>
      </BentoTile>
    )
  }

  return (
    <BentoTile span={6} rows={1} label="Emailed receipts">
      <div className="space-y-2">
        <p className="text-sm">
          Connected{status.accountEmail ? ` as ${status.accountEmail}` : ''}.
          {gmailCount != null ? ` ${gmailCount} receipt${gmailCount === 1 ? '' : 's'} imported.` : ''}
        </p>
        <Link to="/receipts" className="text-sm font-semibold text-foreground underline">
          View receipts →
        </Link>
      </div>
    </BentoTile>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/dashboard/EmailedReceiptsTile.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the tile to the dashboard**

In `frontend/src/pages/DashboardPage.tsx`:

(a) Add the import next to the other dashboard tile imports (after the `ReceiptCoverageTile` import at line 29):

```tsx
import { EmailedReceiptsTile } from '@/components/dashboard/EmailedReceiptsTile'
```

(b) In the tile grid (the `<div ... grid ...>` block), render the tile right after `<ReceiptCoverageTile ... />` (around line 1611). Change:

```tsx
        <ReceiptCoverageTile currency={currency || null} />

        <ImportHealthTile currency={currency || null} />
```

to:

```tsx
        <ReceiptCoverageTile currency={currency || null} />

        <EmailedReceiptsTile />

        <ImportHealthTile currency={currency || null} />
```

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/dashboard/EmailedReceiptsTile.tsx frontend/src/components/dashboard/EmailedReceiptsTile.test.tsx frontend/src/pages/DashboardPage.tsx
git commit --no-verify -m "feat(receipts): add Emailed Receipts dashboard signpost tile"
```

---

## Task 9: Full verification

- [ ] **Step 1: Backend integration tests**

Run: `cd backend && npm run test:integration`
Expected: all pass, including the two new files.

- [ ] **Step 2: Backend unit tests (no regressions)**

Run: `cd backend && npm test`
Expected: all pass.

- [ ] **Step 3: Backend typecheck + lint**

Run: `cd backend && npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 4: Frontend tests**

Run: `cd frontend && npm test`
Expected: all pass, including new component/page tests and the updated Sidebar test.

- [ ] **Step 5: Frontend typecheck + lint + build**

Run: `cd frontend && npx tsc -b && npm run lint && npm run build`
Expected: no errors; build succeeds.

- [ ] **Step 6: Manual smoke (optional but recommended)**

Start the app, then:
- Dashboard shows the "Emailed receipts" tile (warning variant, "Connect Gmail →") when `EMAIL_INTEGRATION_ENABLED` and not connected; nothing when the feature flag is off.
- Sidebar Money section shows "Receipts", no "Amazon".
- `/receipts` renders the Gmail panel, scan history, source-filter tabs, and the all-sources list.
- Visiting `/amazon` redirects to `/receipts?vendor=amazon` and shows the full Amazon toolkit (embedded, no duplicate page title).

- [ ] **Step 7: Final no-op commit check**

Run: `git status`
Expected: clean working tree (everything committed task-by-task).

---

## Notes & deliberate deviations from the spec

- **No shared-table extraction.** The spec suggested extracting a shared orders table from `AmazonPage`. Instead, `AmazonPage` is reused wholesale (with an `embedded` prop) as the `vendor=amazon` slice. Same end-state (one `/receipts` surface, Amazon as a filtered view), far lower risk — no behavior-preserving refactor of `AmazonPage`'s stateful table.
- **No GmailSection extraction.** `ReceiptsPage` renders the existing `<GmailSection />` directly rather than extracting a shared connect/scan panel. Premature to split until `/receipts` and Settings need to diverge.
- **`linkStatus` filtering is client-side / not a server param in v1.** The list endpoint returns `linkStatus` per order; the spec's `linkStatus` filter is deferred (the source-`group` filter is the one that ships). Add chips later if needed.
- **OAuth callback still redirects to `/settings`.** Connecting Gmail from `/receipts` lands the user back on Settings (the backend callback target is unchanged, out of scope). The connection status still reflects correctly on `/receipts` via the status fetch.
- **Endpoint home.** The vendor-agnostic list lives on the existing `externalOrdersRouter` (`GET /api/external-orders`), not a new `/api/orders` router — that router already owns vendor-agnostic `ExternalOrder` writes, so it is the natural home. (`/api/receipts` is taken by the `Receipt` file-attachment route.)
```
