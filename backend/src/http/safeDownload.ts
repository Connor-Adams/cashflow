import type { Response } from 'express';

/**
 * Stored-XSS hardening for user-uploaded file downloads (issue #819).
 *
 * User-controlled bytes are served from the app's own origin by the vault and
 * receipt download endpoints. If served inline with a renderable content-type
 * (e.g. an attacker uploads `<script>` bytes declared `text/plain` or
 * `text/html`), a content-sniffing browser can execute them as a document on
 * the app origin — stored XSS.
 *
 * Two defenses, applied together by `setSafeDownloadHeaders`:
 *  1. `Content-Disposition: attachment` — the browser downloads the file
 *     instead of rendering it inline.
 *  2. A neutralized content-type — raster image types are inert when sniffed
 *     and keep their real type (so previews still work); everything else
 *     (HTML, plain text, SVG, PDF, office docs, JSON, CSV, octet-stream)
 *     collapses to `application/octet-stream`.
 *
 * `X-Content-Type-Options: nosniff` is set globally by helmet in app.ts; this
 * helper re-asserts it on the response as defense-in-depth for the one place
 * where the served bytes are fully attacker-controlled.
 */

/**
 * Raster image types that browsers cannot interpret as executable documents.
 * SVG is deliberately excluded — it is scriptable XML, not an inert image.
 */
const INERT_IMAGE_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/tiff',
]);

const OCTET_STREAM = 'application/octet-stream';

/**
 * Returns a content-type safe to serve for attacker-controlled bytes. Inert
 * raster image types pass through; everything else collapses to
 * application/octet-stream.
 */
export function safeDownloadContentType(mimeType: string): string {
  const normalized = (mimeType ?? '').trim().toLowerCase();
  return INERT_IMAGE_TYPES.has(normalized) ? normalized : OCTET_STREAM;
}

/**
 * Sets the headers required to safely serve a user-uploaded file as a download:
 * `Content-Disposition: attachment`, a neutralized content-type, and an
 * explicit `X-Content-Type-Options: nosniff`. Call this immediately before
 * `res.send(buffer)`.
 */
export function setSafeDownloadHeaders(
  res: Response,
  args: { mimeType: string; originalName: string },
): void {
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(args.originalName)}"`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(safeDownloadContentType(args.mimeType));
}
