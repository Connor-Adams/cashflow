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
 * decided to import it anyway passes `acceptUnreconciled: true`, and that
 * decision is stamped on the resulting ImportHistory row so it can be found
 * later.
 */
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

export function isUnreconciledStatementError(e: unknown): e is UnreconciledStatementError {
  return (
    e instanceof Error &&
    (e as Partial<UnreconciledStatementError>).code === UNRECONCILED_CODE
  );
}

export function unreconciledStatementError(
  fileName: string,
  blocking: readonly StatementParseError[],
): UnreconciledStatementError {
  const detail = blocking.map((e) => e.message).join('; ');
  const err = new Error(
    `Refusing to import "${fileName}": the statement does not reconcile — ${detail}. ` +
      'The parser could not make the statement\'s own arithmetic agree, so the rows it ' +
      'produced cannot be trusted. Re-import once the parser is fixed, or resubmit with ' +
      'acceptUnreconciled: true to import it anyway (the override is recorded on the ' +
      'import history).',
  );
  return Object.assign(err, {
    status: UNRECONCILED_STATUS,
    code: UNRECONCILED_CODE as typeof UNRECONCILED_CODE,
    blockingErrors: [...blocking],
  });
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
