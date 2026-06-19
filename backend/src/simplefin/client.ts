/**
 * SimpleFIN Bridge HTTP client (issue #790).
 *
 * SimpleFIN's connection handshake:
 *   1. The user obtains a one-time **setup token** out-of-band — a base64 string
 *      that decodes to a single **claim URL** (an https URL).
 *   2. We POST (empty body) to that claim URL. SimpleFIN responds with the body
 *      text being a permanent **access URL**: an https URL with embedded HTTP
 *      basic-auth credentials (`https://user:pass@host/...`).
 *   3. Subsequent data reads hit `<access-url>/accounts?...` using the embedded
 *      credentials (fetch honors userinfo in the URL via an Authorization header
 *      we set explicitly, since not every runtime forwards URL userinfo).
 *
 * This module is pure transport + parsing. No DB, no encryption — the service
 * layer (service.ts) owns persistence. HTTP goes through global `fetch` so tests
 * can stub it.
 */

export class SimplefinError extends Error {
  readonly code:
    | 'invalid_setup_token'
    | 'claim_exchange_failed'
    | 'discovery_failed'
    | 'sync_failed';
  /**
   * True when the access URL was rejected as unauthenticated (HTTP 401/403),
   * i.e. the SimpleFIN token was revoked/expired. The sync engine uses this to
   * set the integration `status=error` and surface a reconnect prompt (issue
   * #791), as distinct from a transient transport failure.
   */
  readonly unauthorized: boolean;
  constructor(
    code:
      | 'invalid_setup_token'
      | 'claim_exchange_failed'
      | 'discovery_failed'
      | 'sync_failed',
    message: string,
    opts: { unauthorized?: boolean } = {},
  ) {
    super(message);
    this.name = 'SimplefinError';
    this.code = code;
    this.unauthorized = opts.unauthorized ?? false;
  }
}

/** A SimpleFIN account as returned by the `/accounts` discovery endpoint. */
export interface SimplefinDiscoveredAccount {
  /** SimpleFIN's stable account id, e.g. "ACT-...". */
  id: string;
  name: string;
  /** Trailing account-number digits SimpleFIN exposes, when present. */
  accountNumber?: string | null;
  currency?: string | null;
}

/**
 * Decode a base64 setup token to its claim URL and validate it is an https URL.
 * Throws SimplefinError('invalid_setup_token') on anything malformed.
 */
export function decodeSetupToken(setupToken: string): string {
  const trimmed = (setupToken ?? '').trim();
  if (!trimmed) {
    throw new SimplefinError('invalid_setup_token', 'Setup token is empty');
  }
  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  } catch {
    throw new SimplefinError('invalid_setup_token', 'Setup token is not valid base64');
  }
  if (!decoded) {
    throw new SimplefinError('invalid_setup_token', 'Setup token decoded to empty string');
  }
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new SimplefinError(
      'invalid_setup_token',
      'Setup token did not decode to a URL',
    );
  }
  if (url.protocol !== 'https:') {
    throw new SimplefinError(
      'invalid_setup_token',
      `Claim URL must be https, got ${url.protocol}`,
    );
  }
  return decoded;
}

/**
 * Validate that an access URL is a well-formed https URL with embedded
 * basic-auth credentials. Returns the parsed URL on success.
 */
export function parseAccessUrl(accessUrl: string): URL {
  let url: URL;
  try {
    url = new URL((accessUrl ?? '').trim());
  } catch {
    throw new SimplefinError('claim_exchange_failed', 'Access URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new SimplefinError('claim_exchange_failed', 'Access URL must be https');
  }
  if (!url.username || !url.password) {
    throw new SimplefinError(
      'claim_exchange_failed',
      'Access URL is missing embedded credentials',
    );
  }
  return url;
}

/** Mask an access URL to just its host — never expose credentials. */
export function maskAccessUrlHost(accessUrl: string): string | null {
  try {
    return new URL(accessUrl).host;
  } catch {
    return null;
  }
}

/** Build the Authorization header + base origin path for an access URL. */
export function accessUrlAuth(url: URL): { base: string; authHeader: string } {
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  // Reconstruct the base URL without the userinfo component.
  const base = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
  return { base, authHeader };
}

/**
 * POST the claim URL (empty body) to exchange the setup token for the permanent
 * access URL. Throws SimplefinError('claim_exchange_failed') on non-2xx or an
 * unparseable access URL.
 */
export async function claimAccessUrl(claimUrl: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(claimUrl, {
      method: 'POST',
      headers: { 'Content-Length': '0' },
    });
  } catch (e) {
    throw new SimplefinError(
      'claim_exchange_failed',
      `Claim request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new SimplefinError(
      'claim_exchange_failed',
      `Claim URL returned ${res.status}`,
    );
  }
  const accessUrl = (await res.text()).trim();
  if (!accessUrl) {
    throw new SimplefinError('claim_exchange_failed', 'Claim URL returned no access URL');
  }
  // Validate shape before handing it back for storage.
  parseAccessUrl(accessUrl);
  return accessUrl;
}

interface SimplefinAccountsPayload {
  accounts?: Array<{
    id?: string;
    name?: string;
    currency?: string;
    'account-number'?: string;
    accountNumber?: string;
  }>;
}

/**
 * Enumerate SimpleFIN accounts via `<access>/accounts?balances-only=1`.
 * Lightweight discovery — no transactions are requested. Throws
 * SimplefinError('discovery_failed') on transport/HTTP/parse failure.
 */
export async function discoverAccounts(
  accessUrl: string,
): Promise<SimplefinDiscoveredAccount[]> {
  const { base, authHeader } = accessUrlAuth(parseAccessUrl(accessUrl));
  const url = `${base}/accounts?balances-only=1`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: authHeader } });
  } catch (e) {
    throw new SimplefinError(
      'discovery_failed',
      `Account discovery failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new SimplefinError('discovery_failed', `Discovery returned ${res.status}`);
  }
  let payload: SimplefinAccountsPayload;
  try {
    payload = (await res.json()) as SimplefinAccountsPayload;
  } catch {
    throw new SimplefinError('discovery_failed', 'Discovery response was not JSON');
  }
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  return accounts
    .filter((a) => typeof a?.id === 'string' && a.id)
    .map((a) => ({
      id: String(a.id),
      name: typeof a.name === 'string' && a.name ? a.name : String(a.id),
      accountNumber: a['account-number'] ?? a.accountNumber ?? null,
      currency: typeof a.currency === 'string' ? a.currency : null,
    }));
}

/** A single SimpleFIN transaction as returned by `/accounts`. */
export interface SimplefinTransaction {
  /** SimpleFIN's stable per-transaction id — lands in `sourceReference`. */
  id: string;
  /** Posted epoch seconds (SimpleFIN uses unix seconds). */
  posted: number;
  /** Signed decimal amount as a string (e.g. "-12.34"). */
  amount: string;
  description: string;
  payee?: string | null;
}

/** A SimpleFIN account plus the transactions returned in a sync window. */
export interface SimplefinAccountWithTransactions {
  id: string;
  name: string;
  currency: string | null;
  transactions: SimplefinTransaction[];
}

interface SimplefinTransactionsPayload {
  accounts?: Array<{
    id?: string;
    name?: string;
    currency?: string;
    transactions?: Array<{
      id?: string;
      posted?: number;
      amount?: string | number;
      description?: string;
      payee?: string;
    }>;
  }>;
}

/**
 * Fetch accounts with their transactions posted on/after `startDateEpoch`
 * (unix seconds) via `<access>/accounts?start-date=<epoch>` (issue #791).
 *
 * Throws SimplefinError('sync_failed') on transport/HTTP/parse failure. When
 * the access URL returns 401/403 (token revoked/expired) the error carries
 * `unauthorized: true` so the sync engine can mark the integration in error and
 * surface a reconnect prompt without advancing `lastSyncedAt`.
 */
export async function fetchTransactions(
  accessUrl: string,
  startDateEpoch: number,
): Promise<SimplefinAccountWithTransactions[]> {
  const { base, authHeader } = accessUrlAuth(parseAccessUrl(accessUrl));
  const url = `${base}/accounts?start-date=${Math.floor(startDateEpoch)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: authHeader } });
  } catch (e) {
    throw new SimplefinError(
      'sync_failed',
      `Transaction fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new SimplefinError(
      'sync_failed',
      `Access URL returned ${res.status} (token revoked/expired)`,
      { unauthorized: true },
    );
  }
  if (!res.ok) {
    throw new SimplefinError('sync_failed', `Transaction fetch returned ${res.status}`);
  }
  let payload: SimplefinTransactionsPayload;
  try {
    payload = (await res.json()) as SimplefinTransactionsPayload;
  } catch {
    throw new SimplefinError('sync_failed', 'Transaction response was not JSON');
  }
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  return accounts
    .filter((a) => typeof a?.id === 'string' && a.id)
    .map((a) => ({
      id: String(a.id),
      name: typeof a.name === 'string' && a.name ? a.name : String(a.id),
      currency: typeof a.currency === 'string' ? a.currency : null,
      transactions: (Array.isArray(a.transactions) ? a.transactions : [])
        .filter((tx) => typeof tx?.id === 'string' && tx.id)
        .map((tx) => ({
          id: String(tx.id),
          posted: typeof tx.posted === 'number' ? tx.posted : 0,
          amount: tx.amount == null ? '0' : String(tx.amount),
          description: typeof tx.description === 'string' ? tx.description : '',
          payee: typeof tx.payee === 'string' ? tx.payee : null,
        })),
    }));
}
