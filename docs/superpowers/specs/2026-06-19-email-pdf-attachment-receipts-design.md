# Email Receipts — PDF Attachment Extraction (Phase 2)

**Date:** 2026-06-19
**Status:** Approved
**Builds on:** `docs/superpowers/specs/2026-06-18-smarter-email-discovery-design.md` (Phase 1, shipped in PR #770).
**Primitive impact:** None. Reuses the receipt pipeline (Transaction/Document side); no new model, no new status machine.

## Problem

Many receipts arrive as a **PDF attachment** with a near-empty email body — utilities,
SaaS invoices, contractors, telecoms. The current Gmail pipeline only reads the email
*body* (`extractMessageBody`), so these emails extract to nothing:

- **Fast scan** (`scanInbox`): an allowlist sender (e.g. a utility you approved) sends
  "Your invoice is attached" + a PDF → the body parses to `no_items` and the receipt is
  dropped.
- **Discovery** (`discoverReceiptSources`): a PDF invoice from an unknown sender never
  even matches the broad query, and if it did, the empty body yields nothing.

Phase 2 adds PDF-attachment text extraction to **both** pipelines so these receipts are
captured, reusing the existing `extractPdfLines` (pdfjs) primitive.

## Approach

A shared PDF-text fallback. When an email body yields **no clean extract** (empty body
*or* a parse that produces no items), and the message has PDF attachments, download the
PDFs, extract their text, and re-run the same deterministic→AI receipt parse on that
text. Whichever source produces items wins.

The fast scan needs **no Gmail-query change** — `from:(allowlist)` already returns the
sender's PDF-bearing emails; PDF handling is purely a processing fallback. Discovery
flips its existing `includePdfAttachments` query clause **on** (Phase 1 left it gated
off) so PDF invoices from unknown senders are pulled into the broad net.

### Confidence — unchanged

PDF text almost always routes to AI extraction (the deterministic vendor parsers key on
email sender/format, not PDF layout). The Phase 1 confidence tiering is reused verbatim:

- **Discovery:** a PDF-sourced AI extract is HIGH (auto-ingest + auto-learn sender) only
  when `category:purchases`/keyword + clean extract + a matching `Transaction`; otherwise
  it becomes a sender suggestion. No order is written for a low-confidence PDF receipt.
- **Fast scan:** allowlist senders are already trusted, so a PDF-sourced order is created
  like any other body-sourced order.

No new confidence logic is introduced.

## Components

### 1. `fetchAttachment` — `backend/src/integrations/gmail.ts`

```ts
export async function fetchAttachment(opts: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
}): Promise<Buffer>
```

Hits `GET {GMAIL_API}/messages/{messageId}/attachments/{attachmentId}` with the bearer
token (mirrors `fetchMessage`'s fetch/error style). The response is
`{ size, data }` where `data` is base64url; decode to a `Buffer` (reuse the existing
base64url decode logic). Throws on non-2xx, matching `fetchMessage`.

### 2. `backend/src/integrations/pdfAttachments.ts` (new)

```ts
export interface PdfAttachmentRef {
  attachmentId: string;
  filename: string | null;
  size: number;          // bytes, from part.body.size (0 if unknown)
}

/** Recursively walk the MIME tree for PDF parts that carry an attachmentId.
 *  Matches mimeType 'application/pdf' OR a filename ending '.pdf' (case-insensitive). */
export function collectPdfParts(payload: GmailPayload): PdfAttachmentRef[];

export interface PdfTextDeps {
  fetchAttachment: typeof fetchAttachment;
  extractPdfLines: (buffer: Buffer) => Promise<{ text: string }[]>;
}

/** Download up to MAX_PDFS attachments (skipping any over MAX_PDF_BYTES), extract
 *  their text via extractPdfLines, and concatenate. Returns '' when there are no
 *  usable PDFs or none yield text. Best-effort: a per-PDF fetch/parse failure is
 *  logged and skipped, never thrown. Deps injectable for tests. */
export async function extractPdfReceiptText(
  opts: { accessToken: string; messageId: string; payload: GmailPayload },
  deps?: Partial<PdfTextDeps>,
): Promise<string>;
```

- `MAX_PDFS = 3`, `MAX_PDF_BYTES = 10 * 1024 * 1024` (module constants).
- Text per PDF = `lines.map(l => l.text).join('\n')`; PDFs joined with `'\n\n'`.
- `extractPdfLines` does **no OCR**, so scanned-image PDFs return no text → `''` → the
  caller falls through to `no_items`. This is the expected, non-error path.

### 3. Integration into both pipelines

Both `scanInbox` (`scanReceipts.ts`) and `discoverReceiptSources` (`discoverReceiptSources.ts`)
share the same shape inside their per-message processing. After the existing body-parse
produces `extracted`/`parser`:

```
hasCleanExtract = extracted != null && extracted.total != null && extracted.items.length > 0
if (!hasCleanExtract && collectPdfParts(full.payload).length > 0):
    pdfText = await extractPdfReceiptText({ accessToken, messageId, payload: full.payload })
    if (pdfText.trim()):
        re-run the SAME parse (tryDeterministicParse then extractReceiptFromText) on pdfText
        if it now yields items: adopt that extracted/parser, set fromPdf = true
```

- When a PDF parse is adopted, `ExternalOrder.source` is suffixed `-pdf`:
  `gmail-scan:ai-pdf` (fast scan) / `gmail-discovery:ai-pdf` (discovery). The suffix is
  applied to whatever parser produced the adopted extract (`<parser>-pdf`).
- The empty-body branch (`!body.trim()`) no longer immediately fails: it proceeds to the
  PDF fallback first, and only records `extraction_failed`/`no_items` if the PDF path also
  yields nothing.
- Discovery's confidence classification then runs on the adopted extract exactly as in
  Phase 1 (the `fromPdf` receipts are AI-parsed, so they go through the
  purchases+amount-match gate).

To keep the body→PDF parse logic from diverging between the two pipelines, factor the
"parse this text (deterministic→AI)" step into a small shared helper if it is not already
shared at implementation time; otherwise mirror it with the `fallow-ignore` convention the
repo already uses for the order-persist block. The implementation plan decides the exact
seam.

### 4. Discovery query clause

In the discover route / `buildDiscoveryQuery` call site, pass `includePdfAttachments: true`
so the broad query includes `(has:attachment filename:pdf subject:(invoice OR receipt))`.
The fast scan's `buildGmailQuery` is unchanged.

## Guards

- Per-message: at most `MAX_PDFS` (3) attachments fetched; any part whose `size` exceeds
  `MAX_PDF_BYTES` (10 MB) is skipped (logged).
- Per-PDF fetch or `extractPdfLines` failure is caught, logged (`pdf_attachment_failed`),
  and skipped — never fails the message or the run.
- PDF fallback only runs when the body produced no clean extract, so receipts whose body
  already parses incur zero extra Gmail/PDF work.

## Testing

**Unit (SQLite/pure, colocated):**
- `collectPdfParts` — finds `application/pdf` and `.pdf` parts at nested depths; ignores
  inline/non-PDF parts and PDF parts lacking an `attachmentId`.
- `extractPdfReceiptText` (injected `fetchAttachment` + `extractPdfLines`) — concatenates
  text across multiple PDFs; caps at `MAX_PDFS`; skips oversize parts; returns `''` when
  no PDFs / all yield empty text; a thrown fetch on one PDF is skipped, not propagated.
- A base64url→Buffer decode unit for `fetchAttachment`'s decode step.

**Orchestrator (discovery, via the existing deps seam):**
- A message with an empty/sparse body **and** a PDF attachment whose extracted text the
  injected AI extractor turns into a clean order: with a matching transaction → auto-ingest
  with `source = 'gmail-discovery:ai-pdf'`; without a match → sender suggestion, no order.
- A message whose body already yields items → PDF fetch is **not** attempted (assert the
  injected `fetchAttachment` was not called).

**Fast scan:** the shared PDF helper is covered by its own unit test; wiring into
`scanInbox` is exercised by extending the existing receipt-scan integration coverage with a
PDF-attachment message (or a focused test if a deps seam is added during implementation).

## Out of scope

- OCR of scanned-image PDFs (no text layer) — `extractPdfLines` is text-extraction only.
- Non-PDF attachments (images, .eml, Office docs).
- Re-deriving Phase 1's confidence tiers — reused as-is.
- Backfilling already-processed messages: PDF extraction applies to messages scanned after
  this ships (already-seen messageIds are skipped, as in Phase 1).
