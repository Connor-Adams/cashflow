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
