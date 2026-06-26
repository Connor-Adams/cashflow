// Shapes the *client-facing* error payload for the terminal Express error
// handler. The guiding rule (issue #820): never leak raw internal error text on
// 5xx responses. Sequelize/DB errors, filesystem paths, and internal invariants
// frequently surface in `err.message`; for any server error (status >= 500) the
// client gets a generic message and the full detail is kept in the server logs.

type ErrorWithMetadata = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const isObjectError = (err: unknown): err is ErrorWithMetadata =>
  Boolean(err) && typeof err === 'object';

export const getErrorCode = (err: unknown): string =>
  isObjectError(err) && 'code' in err ? String(err.code) : '';

export const getErrorStatus = (err: unknown, code: string): number => {
  if (code === 'LIMIT_FILE_SIZE') {
    return 400;
  }

  const rawStatus =
    isObjectError(err) && 'status' in err
      ? err.status
      : isObjectError(err) && 'statusCode' in err
        ? err.statusCode
        : undefined;
  const status = Number(rawStatus) || 500;

  return status >= 400 && status < 600 ? status : 500;
};

// A generic fallback per status class so 4xx errors without a usable message
// still get a sensible client message rather than echoing internal text.
const genericMessageForStatus = (status: number): string =>
  status >= 500 ? 'Internal Server Error' : 'Bad Request';

// Only pass `err.message` through for 4xx with an explicit, safe message.
// 5xx always returns a generic message — the raw text stays in the logs only.
export const getClientErrorMessage = (err: unknown, status: number): string => {
  if (status >= 500) {
    return 'Internal Server Error';
  }

  if (
    err instanceof Error &&
    err.message &&
    !err.message.includes('ENOENT')
  ) {
    return err.message;
  }

  return genericMessageForStatus(status);
};
