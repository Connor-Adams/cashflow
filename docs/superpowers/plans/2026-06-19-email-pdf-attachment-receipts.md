# PDF Attachment Receipt Extraction (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture receipts that arrive as PDF email attachments by extracting their text and feeding it through the existing receipt parse pipeline, in both the fast scan and the discovery pass.

**Architecture:** A shared PDF-text fallback. When an email body produces no clean receipt extract (empty body or a parse with no items) and the message has PDF attachments, download the PDFs (`fetchAttachment`), extract text with the existing `extractPdfLines` (pdfjs), and re-run the same deterministic→AI parse on that text. The det→AI parse is factored into a shared `parseReceiptText` helper used by both pipelines and the PDF fallback. Confidence tiering is unchanged.

**Tech Stack:** TypeScript, Express, Sequelize (SQLite/Postgres dual-dialect), `pdfjs-dist` (legacy build), `node:test` via `tsx`.

## Global Constraints

- Backend tests are `node:test` via `tsx`, colocated `*.test.ts` under `backend/src/`. Run one file: `cd backend && yarn tsx --import ./test/setup.ts --test src/<path>.test.ts`.
- Unit-test DB schema comes from models' `sequelize.sync()`; no migration in this phase (no schema change).
- Sequelize must run on SQLite and Postgres. No `Co-Authored-By` / co-author trailers in commits.
- Commits need the repo-root bin on PATH (husky/lint-staged): prefix with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …`.
- Work and commit ONLY in cwd `/Users/connoradams/Developer/cashflow/.claude/worktrees/sleepy-kepler-ccaaae` on branch `claude/email-pdf-phase2` (except `cd backend` to run tests). After each commit, confirm `git rev-parse --abbrev-ref HEAD` is `claude/email-pdf-phase2`.
- `extractPdfLines` does NO OCR — scanned-image PDFs return no text; that path must fall through to `no_items`/`extraction_failed`, never crash.
- Multi-currency: never fabricate `'USD'` — use `receiptCurrencyOrDefault`.
- PDF guards: `MAX_PDFS = 3` attachments per message, `MAX_PDF_BYTES = 10 * 1024 * 1024`.

---

### Task 1: `fetchAttachment` + base64url→Buffer decode

**Files:**
- Modify: `backend/src/integrations/gmail.ts`
- Test: `backend/src/integrations/gmailAttachment.test.ts`

**Interfaces:**
- Produces:
  - `base64UrlToBuffer(b64url: string): Buffer` — decode a base64url string to raw bytes.
  - `fetchAttachment(opts: { accessToken: string; messageId: string; attachmentId: string }): Promise<Buffer>` — GET `messages/{messageId}/attachments/{attachmentId}`, returns the decoded bytes.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/gmailAttachment.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64UrlToBuffer } from './gmail';

test('base64UrlToBuffer decodes base64url (URL-safe alphabet) to raw bytes', () => {
  // "%PDF-1." in base64url. Standard base64 would be "JVBERi0xLg==".
  const b64url = 'JVBERi0xLg';
  const buf = base64UrlToBuffer(b64url);
  assert.equal(buf.toString('latin1'), '%PDF-1.');
});

test('base64UrlToBuffer handles the URL-safe chars - and _', () => {
  // bytes 0xfb 0xff 0xbf -> standard base64 "+/+/", base64url "-_-_"
  const buf = base64UrlToBuffer('-_-_');
  assert.deepEqual([...buf], [0xfb, 0xff, 0xbf]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/gmailAttachment.test.ts`
Expected: FAIL — `base64UrlToBuffer` is not exported.

- [ ] **Step 3: Implement**

In `backend/src/integrations/gmail.ts`, add near the existing `base64UrlDecodeToUtf8` helper:

```typescript
/** Decode a base64url string to raw bytes (binary-safe, unlike the utf8 variant). */
export function base64UrlToBuffer(b64url: string): Buffer {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}
```

And add the attachment fetcher (place after `fetchMessage`):

```typescript
/**
 * Download a single message attachment by its attachmentId. Gmail returns
 * `{ size, data }` where `data` is base64url; we return the decoded bytes.
 * Mirrors fetchMessage's auth + error handling.
 */
export async function fetchAttachment(opts: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
}): Promise<Buffer> {
  const url = `${GMAIL_API}/messages/${encodeURIComponent(opts.messageId)}/attachments/${encodeURIComponent(opts.attachmentId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gmail attachment get failed (${res.status}): ${t.slice(0, 400)}`);
  }
  const j = (await res.json()) as { size?: number; data?: string };
  return base64UrlToBuffer(j.data ?? '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/gmailAttachment.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/integrations/gmail.ts backend/src/integrations/gmailAttachment.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): Gmail attachment fetch + base64url-to-buffer decode"
```

---

### Task 2: `pdfAttachments.ts` — collect parts + extract text

**Files:**
- Create: `backend/src/integrations/pdfAttachments.ts`
- Test: `backend/src/integrations/pdfAttachments.test.ts`

**Interfaces:**
- Consumes: `fetchAttachment` (Task 1); `extractPdfLines` from `../import/pdf/extractLines` (`(buffer: Buffer) => Promise<PdfLine[]>`, each `PdfLine` has a `text: string`); the `GmailPayload` shape (recursive: `{ mimeType?, filename?, body?: { size?, attachmentId? }, parts?: GmailPayload[] }`).
- Produces:
  - `interface PdfAttachmentRef { attachmentId: string; filename: string | null; size: number }`
  - `collectPdfParts(payload: GmailPayloadLike): PdfAttachmentRef[]`
  - `interface PdfTextDeps { fetchAttachment: typeof fetchAttachment; extractPdfLines: (buffer: Buffer) => Promise<{ text: string }[]> }`
  - `extractPdfReceiptText(opts: { accessToken: string; messageId: string; payload: GmailPayloadLike }, deps?: Partial<PdfTextDeps>): Promise<string>`
  - `MAX_PDFS` (3) and `MAX_PDF_BYTES` (10485760) exported consts.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/pdfAttachments.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPdfParts, extractPdfReceiptText, MAX_PDFS } from './pdfAttachments';

const pdfPart = (attachmentId: string, filename: string | null, mimeType: string, size = 1000) => ({
  mimeType, filename: filename ?? undefined, body: { size, attachmentId },
});

test('collectPdfParts finds application/pdf and .pdf parts with an attachmentId, nested', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: 'aGk' } },
      pdfPart('att-1', 'invoice.pdf', 'application/pdf'),
      { mimeType: 'multipart/alternative', parts: [pdfPart('att-2', 'RECEIPT.PDF', 'application/octet-stream')] },
      // No attachmentId -> ignored
      { mimeType: 'application/pdf', filename: 'x.pdf', body: { size: 10 } },
      // Not a pdf -> ignored
      pdfPart('att-3', 'photo.jpg', 'image/jpeg'),
    ],
  };
  const refs = collectPdfParts(payload);
  assert.deepEqual(refs.map((r) => r.attachmentId), ['att-1', 'att-2']);
});

test('extractPdfReceiptText concatenates text across PDFs and caps at MAX_PDFS', async () => {
  const payload = {
    parts: Array.from({ length: 5 }, (_, i) => pdfPart(`a${i}`, `f${i}.pdf`, 'application/pdf')),
  };
  const fetched: string[] = [];
  const text = await extractPdfReceiptText(
    { accessToken: 'tok', messageId: 'm1', payload },
    {
      fetchAttachment: async ({ attachmentId }) => { fetched.push(attachmentId); return Buffer.from(attachmentId); },
      extractPdfLines: async (buf) => [{ text: `line-${buf.toString()}` }],
    },
  );
  assert.equal(fetched.length, MAX_PDFS); // capped
  assert.match(text, /line-a0/);
  assert.match(text, /line-a2/);
});

test('extractPdfReceiptText skips oversize attachments', async () => {
  const payload = { parts: [{ mimeType: 'application/pdf', filename: 'big.pdf', body: { size: 99 * 1024 * 1024, attachmentId: 'big' } }] };
  let called = false;
  const text = await extractPdfReceiptText(
    { accessToken: 't', messageId: 'm', payload },
    { fetchAttachment: async () => { called = true; return Buffer.from(''); }, extractPdfLines: async () => [{ text: 'x' }] },
  );
  assert.equal(called, false);
  assert.equal(text, '');
});

test('extractPdfReceiptText returns empty string when there are no PDFs', async () => {
  const text = await extractPdfReceiptText(
    { accessToken: 't', messageId: 'm', payload: { parts: [{ mimeType: 'text/plain', body: { data: 'aGk' } }] } },
    { fetchAttachment: async () => Buffer.from(''), extractPdfLines: async () => [{ text: 'x' }] },
  );
  assert.equal(text, '');
});

test('extractPdfReceiptText skips a PDF whose fetch throws, keeps the others', async () => {
  const payload = { parts: [pdfPart('bad', 'a.pdf', 'application/pdf'), pdfPart('good', 'b.pdf', 'application/pdf')] };
  const text = await extractPdfReceiptText(
    { accessToken: 't', messageId: 'm', payload },
    {
      fetchAttachment: async ({ attachmentId }) => { if (attachmentId === 'bad') throw new Error('boom'); return Buffer.from('ok'); },
      extractPdfLines: async () => [{ text: 'good-text' }],
    },
  );
  assert.match(text, /good-text/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/pdfAttachments.test.ts`
Expected: FAIL — module `./pdfAttachments` not found.

- [ ] **Step 3: Implement**

Create `backend/src/integrations/pdfAttachments.ts`:

```typescript
/**
 * Extract receipt text from a Gmail message's PDF attachments. Used as a
 * fallback by both the fast scan and the discovery pass when an email body
 * yields no usable receipt. Reuses the import pipeline's extractPdfLines (pdfjs,
 * text-only — no OCR). Gmail fetch + pdf extraction are injectable for tests.
 */
import { fetchAttachment as realFetchAttachment } from './gmail';
import { extractPdfLines as realExtractPdfLines } from '../import/pdf/extractLines';
import { logger } from '../observability/logger';

export const MAX_PDFS = 3;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Minimal structural shape of a Gmail payload node we walk. */
export interface GmailPayloadLike {
  mimeType?: string;
  filename?: string;
  body?: { size?: number; attachmentId?: string };
  parts?: GmailPayloadLike[];
}

export interface PdfAttachmentRef {
  attachmentId: string;
  filename: string | null;
  size: number;
}

export interface PdfTextDeps {
  fetchAttachment: typeof realFetchAttachment;
  extractPdfLines: (buffer: Buffer) => Promise<{ text: string }[]>;
}

function isPdfPart(p: GmailPayloadLike): boolean {
  const mime = (p.mimeType ?? '').toLowerCase();
  const name = (p.filename ?? '').toLowerCase();
  return mime === 'application/pdf' || name.endsWith('.pdf');
}

/** Recursively collect PDF attachment parts that carry an attachmentId. */
export function collectPdfParts(payload: GmailPayloadLike): PdfAttachmentRef[] {
  const out: PdfAttachmentRef[] = [];
  function walk(p: GmailPayloadLike | undefined): void {
    if (!p) return;
    const attachmentId = p.body?.attachmentId;
    if (attachmentId && isPdfPart(p)) {
      out.push({ attachmentId, filename: p.filename ?? null, size: p.body?.size ?? 0 });
    }
    for (const part of p.parts ?? []) walk(part);
  }
  walk(payload);
  return out;
}

/**
 * Download up to MAX_PDFS attachments (skipping any over MAX_PDF_BYTES), extract
 * their text, and concatenate (PDFs joined by a blank line). Best-effort: a
 * per-PDF fetch/parse failure is logged and skipped. Returns '' when nothing
 * usable is found.
 */
export async function extractPdfReceiptText(
  opts: { accessToken: string; messageId: string; payload: GmailPayloadLike },
  deps: Partial<PdfTextDeps> = {},
): Promise<string> {
  const fetchAttachment = deps.fetchAttachment ?? realFetchAttachment;
  const extractPdfLines = deps.extractPdfLines ?? realExtractPdfLines;

  const refs = collectPdfParts(opts.payload)
    .filter((r) => r.size <= MAX_PDF_BYTES)
    .slice(0, MAX_PDFS);

  const chunks: string[] = [];
  for (const ref of refs) {
    try {
      const buf = await fetchAttachment({
        accessToken: opts.accessToken,
        messageId: opts.messageId,
        attachmentId: ref.attachmentId,
      });
      const lines = await extractPdfLines(buf);
      const text = lines.map((l) => l.text).join('\n').trim();
      if (text) chunks.push(text);
    } catch (err) {
      logger.warn(
        { messageId: opts.messageId, attachmentId: ref.attachmentId, error: err instanceof Error ? err.message : String(err) },
        'pdf_attachment_failed',
      );
    }
  }
  return chunks.join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/pdfAttachments.test.ts`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/integrations/pdfAttachments.ts backend/src/integrations/pdfAttachments.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): PDF attachment collection + text extraction"
```

---

### Task 3: Shared `parseReceiptText` + discovery PDF fallback

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts` (add `parseReceiptText`)
- Modify: `backend/src/integrations/discoverReceiptSources.ts`
- Test: `backend/src/integrations/discoverReceiptSources.test.ts` (extend)

**Interfaces:**
- Consumes: `tryDeterministicParse` (parsers), `extractReceiptFromText` (ai), `ExtractedReceiptOrder` type; `collectPdfParts`, `extractPdfReceiptText` (Task 2); discovery's existing `DiscoveryDeps` (adds `extractPdfReceiptText`).
- Produces (in `scanReceipts.ts`):
  ```ts
  export async function parseReceiptText(opts: {
    fromAddress: string | null;
    subject: string | null;
    text: string;
    extractFromText: (text: string) => Promise<ExtractedReceiptOrder>;
  }): Promise<{ extracted: ExtractedReceiptOrder; parser: string; usedAi: boolean }>
  ```

- [ ] **Step 1: Add `parseReceiptText` to `scanReceipts.ts`**

`scanReceipts.ts` already imports `tryDeterministicParse` and `type ExtractedReceiptOrder`. Add this exported helper (e.g. after `buildDiscoveryQuery`):

```typescript
/**
 * Parse receipt text (an email body OR PDF-extracted text) into a structured
 * order: try the cheap deterministic vendor parsers first, then fall back to AI.
 * `extractFromText` is injected so callers (and tests) can supply the real AI
 * extractor or a fake. `usedAi` lets callers track AI-call counts.
 */
export async function parseReceiptText(opts: {
  fromAddress: string | null;
  subject: string | null;
  text: string;
  extractFromText: (text: string) => Promise<ExtractedReceiptOrder>;
}): Promise<{ extracted: ExtractedReceiptOrder; parser: string; usedAi: boolean }> {
  const det = tryDeterministicParse({ fromAddress: opts.fromAddress, subject: opts.subject, body: opts.text });
  if (det.ok) return { extracted: det.order, parser: det.parser, usedAi: false };
  const extracted = await opts.extractFromText(opts.text);
  return { extracted, parser: 'ai', usedAi: true };
}
```

- [ ] **Step 2: Write the failing discovery tests**

Add to `backend/src/integrations/discoverReceiptSources.test.ts` (reuse its existing `before`/`beforeEach`, `fakeMessage`, `deps`, and `cleanExtract` fixtures). These two tests need a message with an empty body plus a PDF attachment, and a `deps` that injects `extractPdfReceiptText` and a PDF-aware extractor.

```typescript
test('a PDF attachment on an empty-body message is extracted and auto-ingested when an amount matches', async () => {
  await Transaction.create({
    householdId: 1, date: '2026-06-10', amount: '42.00', currency: 'CAD',
    merchantRaw: 'PDFSHOP', merchantClean: 'Pdfshop',
  } as never);
  // Empty body, one PDF attachment part.
  const msg = {
    id: 'pdf1', threadId: 't', internalDate: '1718000000000', labelIds: ['CATEGORY_PURCHASES'],
    payload: {
      headers: [{ name: 'From', value: 'Shop <orders@pdfshop.test>' }, { name: 'Subject', value: 'Your invoice' }],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('   ').toString('base64url') } },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { size: 2000, attachmentId: 'att-pdf1' } },
      ],
    },
  } as unknown as GmailMessageFull;

  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    {
      listMessageIds: async () => [{ id: 'pdf1', threadId: 't' }],
      fetchMessage: async () => msg,
      // body is empty -> extractFromText would receive '' or pdf text; return no items for empty, clean for pdf text
      extractFromText: async (text: string) => (text.includes('PDF-RECEIPT') ? cleanExtract : { ...cleanExtract, total: null, items: [] }),
      extractPdfReceiptText: async () => 'PDF-RECEIPT total 42.00',
    },
  );
  assert.equal(result.autoIngested, 1);
  assert.equal(await ExternalOrder.count(), 1);
  const order = await ExternalOrder.findOne();
  assert.equal(order?.source, 'gmail-discovery:ai-pdf');
});

test('PDF fetch is NOT attempted when the body already yields items', async () => {
  let pdfCalled = false;
  const msg = fakeMessage({ id: 'nopdf', from: 'A <a@a.test>', subject: 'Your order confirmation', labelIds: ['CATEGORY_PURCHASES'] });
  await Transaction.create({ householdId: 1, date: '2026-06-10', amount: '42.00', currency: 'CAD', merchantRaw: 'A', merchantClean: 'A' } as never);
  await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    {
      listMessageIds: async () => [{ id: 'nopdf', threadId: 't1' }],
      fetchMessage: async () => msg,
      extractFromText: async () => cleanExtract,
      extractPdfReceiptText: async () => { pdfCalled = true; return 'x'; },
    },
  );
  assert.equal(pdfCalled, false);
});
```

(If the existing `deps(...)` helper in the test file does not already include `extractPdfReceiptText`, pass the deps inline as shown above.)

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoverReceiptSources.test.ts`
Expected: FAIL — the new tests fail because discovery does not yet attempt PDF extraction (`autoIngested` 0; `extractPdfReceiptText` not part of `DiscoveryDeps`).

- [ ] **Step 4: Wire the PDF fallback into discovery**

In `backend/src/integrations/discoverReceiptSources.ts`:

(a) Imports — add:
```typescript
import { parseReceiptText, receiptCurrencyOrDefault, /* existing: */ } from './scanReceipts';
import { collectPdfParts, extractPdfReceiptText as realExtractPdfReceiptText } from './pdfAttachments';
```
(`receiptCurrencyOrDefault` is already imported from `./scanReceipts`; add `parseReceiptText` to that existing import line rather than duplicating it.)

(b) Extend `DiscoveryDeps`:
```typescript
export interface DiscoveryDeps {
  listMessageIds: typeof realListMessageIds;
  fetchMessage: typeof realFetchMessage;
  extractFromText: (body: string) => Promise<ExtractedReceiptOrder>;
  extractPdfReceiptText: typeof realExtractPdfReceiptText;
}
```
and in the resolver at the top of `discoverReceiptSources`:
```typescript
  const extractPdfReceiptText = deps.extractPdfReceiptText ?? realExtractPdfReceiptText;
```

(c) Replace the body-parse + empty-body block. The current code (lines ~255–291) is:
```typescript
      const body = extractMessageBody(full.payload);
      if (!body.trim()) {
        r.status = 'extraction_failed';
        r.error = 'empty body';
        failed++;
        await recordProcessed({ messageId: summary.id, status: 'extraction_failed', errorMessage: 'empty body', subject: r.subject, fromAddr: r.from });
        return r;
      }

      let extracted: ExtractedReceiptOrder | null = null;
      let parser = 'ai';
      const det = tryDeterministicParse({ fromAddress: r.from, subject: r.subject, body });
      if (det.ok) {
        extracted = det.order;
        parser = det.parser;
      } else {
        extracted = await extractFromText(body);
        parser = 'ai';
      }
      r.parser = parser;
      r.vendor = extracted.vendor;
      r.total = extracted.total;

      const hasCleanExtract = extracted.total != null && extracted.items.length > 0;
```
Replace it with (note `hasCleanExtract` becomes a `let`, and a new `fromPdf` flag):
```typescript
      const body = extractMessageBody(full.payload);

      let extracted: ExtractedReceiptOrder | null = null;
      let parser = 'ai';
      let fromPdf = false;
      if (body.trim()) {
        const parsed = await parseReceiptText({ fromAddress: r.from, subject: r.subject, text: body, extractFromText });
        extracted = parsed.extracted;
        parser = parsed.parser;
      }

      let hasCleanExtract = extracted != null && extracted.total != null && extracted.items.length > 0;

      // PDF fallback: when the body yielded no clean receipt, try PDF attachments.
      if (!hasCleanExtract && collectPdfParts(full.payload).length > 0) {
        const pdfText = await extractPdfReceiptText({ accessToken, messageId: summary.id, payload: full.payload });
        if (pdfText.trim()) {
          const parsed = await parseReceiptText({ fromAddress: r.from, subject: r.subject, text: pdfText, extractFromText });
          if (parsed.extracted.total != null && parsed.extracted.items.length > 0) {
            extracted = parsed.extracted;
            parser = parsed.parser;
            fromPdf = true;
            hasCleanExtract = true;
          }
        }
      }

      if (extracted == null) {
        // No body text and no usable PDF text.
        r.status = 'extraction_failed';
        r.error = 'empty body';
        failed++;
        await recordProcessed({ messageId: summary.id, status: 'extraction_failed', errorMessage: 'empty body', subject: r.subject, fromAddr: r.from });
        return r;
      }

      r.parser = parser;
      r.vendor = extracted.vendor;
      r.total = extracted.total;
```

(d) Thread `fromPdf` into the persisted order. `persistHighConfidenceOrder` currently begins:
```typescript
  async function persistHighConfidenceOrder(args: {
    extracted: ExtractedReceiptOrder;
    parser: string;
    gmailMessageId: string;
  }): Promise<number> {
    const { extracted, parser, gmailMessageId } = args;
```
Add `fromPdf: boolean;` to the args type and to the destructure:
```typescript
  async function persistHighConfidenceOrder(args: {
    extracted: ExtractedReceiptOrder;
    parser: string;
    gmailMessageId: string;
    fromPdf: boolean;
  }): Promise<number> {
    const { extracted, parser, gmailMessageId, fromPdf } = args;
```
Then change the `source` field (currently `` source: `gmail-discovery:${parser}`, ``) to:
```typescript
          source: `gmail-discovery:${parser}${fromPdf ? '-pdf' : ''}`,
```
Then update its call site in the HIGH branch:
```typescript
        const orderId = await persistHighConfidenceOrder({ extracted, parser, gmailMessageId: summary.id, fromPdf });
```

(e) The downstream `no_items`, `amountMatched`, `classifyDiscoveryConfidence`, and suggestion branches are unchanged — they already read `extracted`, `parser`, `hasCleanExtract`.

- [ ] **Step 5: Flip the discovery query to include PDF-attachment mails**

In `discoverReceiptSources`, find the query build (`const query = buildDiscoveryQuery({ sinceDate, excludeSenders });`) and change it to:
```typescript
  const query = buildDiscoveryQuery({ sinceDate, excludeSenders, includePdfAttachments: true });
```

- [ ] **Step 6: Run discovery tests (new + existing) to verify pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoverReceiptSources.test.ts`
Expected: PASS — the original 3 tests still pass (body-parse behavior unchanged) and the 2 new PDF tests pass.

- [ ] **Step 7: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/integrations/scanReceipts.ts backend/src/integrations/discoverReceiptSources.ts backend/src/integrations/discoverReceiptSources.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): PDF-attachment fallback in discovery pass"
```

---

### Task 4: PDF fallback in the fast scan (`scanInbox`)

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts`
- Test: `backend/src/integrations/scanInboxPdf.test.ts`

**Interfaces:**
- Consumes: `parseReceiptText` (Task 3), `collectPdfParts`/`extractPdfReceiptText` (Task 2), the existing `scanInbox` internals.
- Produces: `scanInbox` gains an optional third `deps` parameter:
  ```ts
  export interface ScanDeps {
    listMessageIds: typeof listMessageIds;
    fetchMessage: typeof fetchMessage;
    extractFromText: (text: string) => Promise<ExtractedReceiptOrder>;
    extractPdfReceiptText: typeof realExtractPdfReceiptText;
  }
  export async function scanInbox(opts: {...}, callbacks?: ScanCallbacks, deps?: Partial<ScanDeps>): Promise<ScanResult>
  ```
  (The existing two-arg call sites continue to work — `deps` defaults to `{}`.)

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/scanInboxPdf.test.ts`:

```typescript
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize, ExternalOrder, ProcessedEmailMessage, UserEmailIntegration, ReceiptSenderAllowlist,
} from '../models';
import { scanInbox } from './scanReceipts';
import { encryptSecret } from '../util/symmetricEncryption';
import type { GmailMessageFull } from './gmail';

before(async () => { await sequelize.sync({ force: true }); });

beforeEach(async () => {
  await Promise.all([
    ExternalOrder.destroy({ where: {} }),
    ProcessedEmailMessage.destroy({ where: {} }),
    UserEmailIntegration.destroy({ where: {} }),
    ReceiptSenderAllowlist.destroy({ where: {} }),
  ]);
  await UserEmailIntegration.create({
    userId: 1, provider: 'google', accountEmail: 'me@gmail.com',
    accessTokenEncrypted: encryptSecret('tok'), refreshTokenEncrypted: encryptSecret('ref'),
    expiresAt: new Date(Date.now() + 3_600_000), scopes: 'gmail.readonly',
    lastScanAt: null, lastHistoryId: null, status: 'connected', statusReason: null,
  } as never);
});

const cleanExtract = {
  vendor: 'other', orderId: 'P-1', orderDate: '2026-06-10', total: 42.0, currency: 'CAD',
  paymentLast4: null, items: [{ title: 'Thing', quantity: 1, unitPrice: 42, totalPrice: 42 }], trip: null,
};

test('scanInbox extracts a receipt from a PDF attachment when the email body is empty', async () => {
  const msg = {
    id: 'pdf-scan-1', threadId: 't', internalDate: '1718000000000',
    payload: {
      headers: [{ name: 'From', value: 'Utility <billing@utility.test>' }, { name: 'Subject', value: 'Your bill' }],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('  ').toString('base64url') } },
        { mimeType: 'application/pdf', filename: 'bill.pdf', body: { size: 1500, attachmentId: 'att-1' } },
      ],
    },
  } as unknown as GmailMessageFull;

  const result = await scanInbox(
    { userId: 1, householdId: 1, maxMessages: 10 },
    {},
    {
      listMessageIds: async () => [{ id: 'pdf-scan-1', threadId: 't' }],
      fetchMessage: async () => msg,
      extractFromText: async (text: string) => (text.includes('BILL-PDF') ? cleanExtract : { ...cleanExtract, total: null, items: [] }),
      extractPdfReceiptText: async () => 'BILL-PDF total 42.00',
    },
  );
  assert.equal(result.createdOrders, 1);
  const order = await ExternalOrder.findOne();
  assert.equal(order?.source, 'gmail-scan:ai-pdf');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanInboxPdf.test.ts`
Expected: FAIL — `scanInbox` does not accept `deps` / does not attempt PDF extraction, so `createdOrders` is 0 (and the empty body currently fails fast).

- [ ] **Step 3: Add the deps seam to `scanInbox`**

In `backend/src/integrations/scanReceipts.ts`:

(a) Add imports near the top:
```typescript
import { collectPdfParts, extractPdfReceiptText as realExtractPdfReceiptText } from './pdfAttachments';
```
(`fetchMessage`, `listMessageIds`, `extractReceiptFromText` are already imported.)

(b) Add the `ScanDeps` interface near `ScanCallbacks`:
```typescript
export interface ScanDeps {
  listMessageIds: typeof listMessageIds;
  fetchMessage: typeof fetchMessage;
  extractFromText: (text: string) => Promise<ExtractedReceiptOrder>;
  extractPdfReceiptText: typeof realExtractPdfReceiptText;
}
```

(c) Change the signature and add resolvers at the top of the function body:
```typescript
export async function scanInbox(
  opts: { userId: number; householdId: number | null; maxMessages?: number; sinceDateOverride?: Date | null },
  callbacks: ScanCallbacks = {},
  deps: Partial<ScanDeps> = {},
): Promise<ScanResult> {
  const listMessageIds = deps.listMessageIds ?? realListMessageIds;
  const fetchMessage = deps.fetchMessage ?? realFetchMessage;
  const extractFromText = deps.extractFromText ?? extractReceiptFromText;
  const extractPdfReceiptText = deps.extractPdfReceiptText ?? realExtractPdfReceiptText;
  // ...existing body...
```
To make `deps.listMessageIds ?? realListMessageIds` work, alias the imports: change the existing `import { ... listMessageIds ... fetchMessage ... } from './gmail';` so they are imported under `realListMessageIds`/`realFetchMessage` aliases:
```typescript
import {
  /* ...other gmail imports unchanged... */
  fetchMessage as realFetchMessage,
  listMessageIds as realListMessageIds,
} from './gmail';
```
Then every existing call to `fetchMessage(...)` / `listMessageIds(...)` inside `scanInbox` now resolves to the local `const fetchMessage` / `const listMessageIds` resolvers — no other call-site edits needed.

- [ ] **Step 4: Route the body-parse through `parseReceiptText` and add the PDF fallback**

In `scanInbox`'s `processOne`, the current block is:
```typescript
      const body = extractMessageBody(full.payload);
      if (!body.trim()) {
        result.status = 'extraction_failed';
        result.error = 'empty body';
        failed++;
        await recordProcessed({ messageId: summary.id, status: 'extraction_failed', parser: null, errorMessage: 'empty body', subject: result.subject, fromAddr: result.from });
        return result;
      }

      // 1) Try the cheap deterministic vendor parser first.
      let extracted: ExtractedReceiptOrder | null = null;
      let parser: string = 'ai';
      const detResult = tryDeterministicParse({ fromAddress: result.from, subject: result.subject, body });
      if (detResult.ok) {
        extracted = detResult.order;
        parser = detResult.parser;
      } else {
        // 2) Fall back to AI extraction.
        extracted = await extractReceiptFromText(body);
        parser = 'ai';
        aiExtractions++;
      }
```
Replace it with:
```typescript
      const body = extractMessageBody(full.payload);

      let extracted: ExtractedReceiptOrder | null = null;
      let parser: string = 'ai';
      let fromPdf = false;
      if (body.trim()) {
        const parsed = await parseReceiptText({ fromAddress: result.from, subject: result.subject, text: body, extractFromText });
        extracted = parsed.extracted;
        parser = parsed.parser;
        if (parsed.usedAi) aiExtractions++;
      }

      const bodyClean = extracted != null && extracted.total != null && extracted.items.length > 0;
      if (!bodyClean && collectPdfParts(full.payload).length > 0) {
        const pdfText = await extractPdfReceiptText({ accessToken, messageId: summary.id, payload: full.payload });
        if (pdfText.trim()) {
          const parsed = await parseReceiptText({ fromAddress: result.from, subject: result.subject, text: pdfText, extractFromText });
          if (parsed.extracted.total != null && parsed.extracted.items.length > 0) {
            extracted = parsed.extracted;
            parser = parsed.parser;
            fromPdf = true;
            if (parsed.usedAi) aiExtractions++;
          }
        }
      }

      if (extracted == null) {
        result.status = 'extraction_failed';
        result.error = 'empty body';
        failed++;
        await recordProcessed({ messageId: summary.id, status: 'extraction_failed', parser: null, errorMessage: 'empty body', subject: result.subject, fromAddr: result.from });
        return result;
      }
```
(The existing Uber override, `result.parser`/`vendor`/`total`/`itemsCount` assignment, the `no_items` check, and the dedupeKey block remain immediately after this and are unchanged — they read `extracted` and `parser`.)

Then change the order's `source` field. In the `ExternalOrder.findOrCreate` defaults, the current line is:
```typescript
            source: `gmail-scan:${parser}`,
```
Change it to:
```typescript
            source: `gmail-scan:${parser}${fromPdf ? '-pdf' : ''}`,
```

- [ ] **Step 5: Run the new test + existing scan tests**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanInboxPdf.test.ts`
Expected: PASS.
Run the existing colocated scan test too:
`cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/scanReceipts.test.ts`
Expected: PASS (unchanged pure-helper tests).

- [ ] **Step 6: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/integrations/scanReceipts.ts backend/src/integrations/scanInboxPdf.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): PDF-attachment fallback in the fast scan"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the whole backend suite**

Run: `yarn workspace cashflow-backend run test`
Expected: PASS, including the new `gmailAttachment`, `pdfAttachments`, `scanInboxPdf`, and extended `discoverReceiptSources` tests.

- [ ] **Step 2: Run CI from the worktree**

Run (MUST be from the worktree root, which has its own node_modules — running from the main checkout gives false module-not-found errors):
`cd /Users/connoradams/Developer/cashflow/.claude/worktrees/sleepy-kepler-ccaaae && yarn ci`
Expected: typecheck, all tests, and both production builds pass.

- [ ] **Step 3: Fix anything CI surfaced, then done**

If clean: push the branch, open a PR, enable auto-merge with a merge commit.

---

## Notes for the implementer

- **No schema change in Phase 2** — no migration. The `-pdf` suffix lives only in the existing `ExternalOrder.source` string.
- **The PDF fallback only fires when the body yields no clean extract**, so receipts whose body already parses incur zero extra Gmail/PDF calls (Task 3/4 tests assert this for discovery).
- **`extractPdfLines` does no OCR.** A scanned-image PDF returns no text → `extractPdfReceiptText` returns `''` → the caller falls through to its existing `no_items`/`extraction_failed` path. Do not add OCR.
- **`parseReceiptText` is the single det→AI parse path** now shared by body parsing, PDF parsing, the fast scan, and discovery. Keep it pure of side effects (no counters, no DB) — callers own counting (`aiExtractions`) and persistence.
- **Confidence tiering is untouched.** A PDF-sourced discovery receipt is AI-parsed, so it still needs purchases-label + amount-match to auto-ingest; otherwise it becomes a sender suggestion.
