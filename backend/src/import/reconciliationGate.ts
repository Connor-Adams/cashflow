/**
 * The statement reconciliation gate.
 *
 * Several PDF statement parsers end with a reconciliation check: recompute the
 * closing balance from the opening balance plus every row parsed, and compare
 * it against the closing balance printed on the page. A mismatch means the
 * parser misread the document — not one row, the document. Those parsers push
 * a `parseError` with `blocking: true`.
 *
 * Before this gate existed nothing acted on that verdict: `commitStatementImport`
 * inserted every row regardless and used the parse-error count only to label the
 * run `partial`. That let a real corruption land — an RBC Royal Credit Line
 * statement booked a +6,400 payment as a -6,400 withdrawal and leaked an
 * interest row into principal, leaving the account wrong by 12,817.24 while the
 * import reported success.
 *
 * So: a blocking error refuses the commit. Nothing is inserted and no
 * ImportHistory row is written. A user who has looked at the statement and
 * decided to import it anyway must acknowledge *that specific discrepancy*:
 * the 422 refusal carries an `acknowledgement` digest derived server-side from
 * the preview token and the blocking errors, and only a request echoing that
 * exact digest back as `acceptUnreconciled` is allowed through. The decision is
 * stamped on the resulting ImportHistory row so it can be found later.
 *
 * Why a digest rather than a boolean: a bare `acceptUnreconciled: true` is a
 * client-supplied value that switches off a safety check, so a caller could
 * disable the gate pre-emptively — set-and-forget — without ever having seen a
 * refusal. (CodeQL flags exactly that shape: js/user-controlled-bypass.) The
 * digest cannot be produced by a client that has not been refused, is bound to
 * one upload, and stops working the moment the statement's blocking errors
 * change, so the value actually controlling the guard is server state.
 */
import crypto from 'node:crypto';

import type { StatementParseError } from './statementTypes';

/** HTTP status the API surfaces for a refused, unreconciled statement. */
export const UNRECONCILED_STATUS = 422;

/** Machine-readable discriminator on the thrown error and the API response. */
export const UNRECONCILED_CODE = 'statement_unreconciled';

export type UnreconciledStatementError = Error & {
  status: number;
  code: typeof UNRECONCILED_CODE;
  blockingErrors: StatementParseError[];
};

/** The subset of parse errors that invalidate the whole statement. */
export function blockingParseErrors(
  parseErrors: readonly StatementParseError[] | undefined,
): StatementParseError[] {
  return (parseErrors ?? []).filter((e) => e.blocking === true);
}

export function unreconciledStatementError(
  fileName: string,
  blocking: readonly StatementParseError[],
): UnreconciledStatementError {
  const detail = blocking.map((e) => e.message).join('; ');
  const err = new Error(
    `Refusing to import "${fileName}": the statement does not reconcile — ${detail}. ` +
      'The parser could not make the statement\'s own arithmetic agree, so the rows it ' +
      'produced cannot be trusted. Re-import once the parser is fixed, or resubmit the ' +
      'same preview with acceptUnreconciled set to the acknowledgement digest returned ' +
      'with this refusal to import it anyway (the override is recorded on the import ' +
      'history).',
  );
  return Object.assign(err, {
    status: UNRECONCILED_STATUS,
    code: UNRECONCILED_CODE as typeof UNRECONCILED_CODE,
    blockingErrors: [...blocking],
  });
}

/**
 * Process-scoped key for acknowledgement digests.
 *
 * Statement previews live in an in-memory map (`statementPreviewStore`), so a
 * preview never outlives the process that minted it; a per-process key is
 * therefore no weaker than the preview itself, and it keeps the digest from
 * being precomputable by anyone who can guess the blocking-error text.
 */
const ACKNOWLEDGEMENT_KEY = crypto.randomBytes(32);

/** Hex characters kept from the HMAC. 32 hex = 128 bits; not brute-forceable. */
const ACKNOWLEDGEMENT_HEX_LENGTH = 32;

/**
 * The digest a client must echo back to override the gate for THIS refusal.
 *
 * Deterministic for a given (previewToken, blocking errors) pair within one
 * process, and bound to both: a digest from another upload, or from the same
 * upload before its blocking errors changed, will not match.
 */
export function unreconciledAcknowledgementDigest(
  previewToken: string,
  blocking: readonly StatementParseError[],
): string {
  const canonical = JSON.stringify({
    previewToken,
    blocking: blocking
      .map((e) => `${e.rowIndex}\u0000${e.message}`)
      .slice()
      .sort(),
  });
  return crypto
    .createHmac('sha256', ACKNOWLEDGEMENT_KEY)
    .update(canonical)
    .digest('hex')
    .slice(0, ACKNOWLEDGEMENT_HEX_LENGTH);
}

/**
 * Does the client-supplied override value acknowledge `expected`?
 *
 * Anything that is not a string of exactly the right length is rejected before
 * the comparison — `true`, `"true"`, a stale digest, a digest from a different
 * preview. The comparison itself is constant-time so the digest cannot be
 * discovered byte-by-byte by timing repeated commits.
 */
export function acknowledgementAccepted(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) return false;
  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}

/**
 * Throw unless the statement reconciles (or the caller knowingly overrode).
 *
 * Returns the blocking errors that the override waved through, so the caller
 * can record them; an empty array means the statement was clean and the
 * override — if passed — was never needed.
 */
export function assertStatementReconciles(
  statement: { fileName: string; parseErrors: readonly StatementParseError[] },
  acceptUnreconciled: boolean,
): StatementParseError[] {
  const blocking = blockingParseErrors(statement.parseErrors);
  if (blocking.length === 0) return [];
  if (!acceptUnreconciled) throw unreconciledStatementError(statement.fileName, blocking);
  return blocking;
}
