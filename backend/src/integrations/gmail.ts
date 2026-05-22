/**
 * gmail — hand-rolled Gmail OAuth + REST client.
 *
 * Avoids the heavy googleapis dependency. We only need:
 *   - generate the OAuth consent URL
 *   - exchange auth code for access + refresh tokens
 *   - refresh access token when expired
 *   - list message IDs matching a sender filter + date window
 *   - fetch a message's body
 *   - revoke the refresh token on disconnect
 */
import {
  googleOauthClientId,
  googleOauthClientSecret,
  googleOauthRedirectUri,
} from '../config/env';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Read-only Gmail scope. The minimum needed to scan + fetch message bodies. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const OPENID_EMAIL_SCOPE = 'openid email';

export interface OauthTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
}

export interface GmailMessageFull {
  id: string;
  threadId: string;
  internalDate: string; // ms since epoch
  payload: GmailPayload;
}

interface GmailPayload {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayload[];
}

function assertOauthConfigured(): void {
  if (!googleOauthClientId || !googleOauthClientSecret) {
    const err = new Error(
      'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.',
    ) as Error & { status?: number };
    err.status = 503;
    throw err;
  }
}

export function buildAuthUrl(state: string, scopes: string[] = [GMAIL_READONLY_SCOPE, OPENID_EMAIL_SCOPE]): string {
  assertOauthConfigured();
  const params = new URLSearchParams({
    client_id: googleOauthClientId!,
    redirect_uri: googleOauthRedirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<OauthTokenResponse> {
  assertOauthConfigured();
  const body = new URLSearchParams({
    code,
    client_id: googleOauthClientId!,
    client_secret: googleOauthClientSecret!,
    redirect_uri: googleOauthRedirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${t.slice(0, 400)}`);
  }
  return (await res.json()) as OauthTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<OauthTokenResponse> {
  assertOauthConfigured();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: googleOauthClientId!,
    client_secret: googleOauthClientSecret!,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google refresh failed (${res.status}): ${t.slice(0, 400)}`);
  }
  return (await res.json()) as OauthTokenResponse;
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

export async function fetchUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { email?: string };
  return j.email ?? null;
}

export async function listMessageIds(opts: {
  accessToken: string;
  query: string;
  maxResults?: number;
}): Promise<GmailMessageSummary[]> {
  const url = new URL(`${GMAIL_API}/messages`);
  url.searchParams.set('q', opts.query);
  url.searchParams.set('maxResults', String(opts.maxResults ?? 100));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gmail list failed (${res.status}): ${t.slice(0, 400)}`);
  }
  const j = (await res.json()) as { messages?: GmailMessageSummary[] };
  return j.messages ?? [];
}

export async function fetchMessage(opts: {
  accessToken: string;
  messageId: string;
}): Promise<GmailMessageFull> {
  const url = `${GMAIL_API}/messages/${encodeURIComponent(opts.messageId)}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gmail get failed (${res.status}): ${t.slice(0, 400)}`);
  }
  return (await res.json()) as GmailMessageFull;
}

function base64UrlDecodeToUtf8(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Recursively walk the MIME tree and return the best body text we can find.
 * Prefers text/plain; falls back to text/html (stripped of tags).
 */
export function extractMessageBody(payload: GmailPayload): string {
  const candidates: Array<{ mime: string; text: string }> = [];

  function walk(p: GmailPayload | undefined) {
    if (!p) return;
    const mime = (p.mimeType ?? '').toLowerCase();
    const data = p.body?.data;
    if (data && (mime === 'text/plain' || mime === 'text/html')) {
      candidates.push({ mime, text: base64UrlDecodeToUtf8(data) });
    }
    for (const part of p.parts ?? []) walk(part);
  }
  walk(payload);

  const plain = candidates.find((c) => c.mime === 'text/plain');
  if (plain) return plain.text;
  const html = candidates.find((c) => c.mime === 'text/html');
  if (html) {
    return html.text
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return '';
}

export function getHeader(payload: GmailPayload, name: string): string | null {
  const want = name.toLowerCase();
  for (const h of payload.headers ?? []) {
    if (h.name.toLowerCase() === want) return h.value;
  }
  return null;
}
