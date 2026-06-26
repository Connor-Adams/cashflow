/**
 * Sender authentication for the discovery pass. Pure — no DB, no network.
 *
 * The discovery query casts a broad net over non-allowlisted senders, so the
 * `From` header alone is attacker-settable: anyone who knows the victim's Gmail
 * address can send an order-confirmation-shaped email spoofing
 * `From: auto-confirm@amazon.com`. To stop a spoof from auto-creating a financial
 * record (or auto-promoting the sender to the household allowlist) we require
 * Gmail's own authentication verdict to vouch for the message.
 *
 * `Authentication-Results` is inserted by the *receiving* server (Gmail) — Gmail
 * strips any inbound copy and writes its own. So when read from the `format=full`
 * payload it reflects Gmail's SPF/DKIM/DMARC validation and is NOT settable by
 * the sender. We gate auto-ingest on **DKIM=pass with the signing domain aligned
 * to the From domain**: a passing DKIM signature from `attacker.test` on a
 * message claiming `From: ...@amazon.com` does not align and is rejected.
 */

/** Lowercased registrable-ish domain of an email address (or raw From header). */
export function domainOf(addressOrHeader: string | null): string | null {
  if (!addressOrHeader) return null;
  const m = addressOrHeader.match(/[^\s<>@]+@([^\s<>@]+\.[^\s<>@]+)/);
  return m ? m[1].toLowerCase() : null;
}

export interface AuthenticationVerdict {
  /** DKIM result token (pass/fail/none/...) or null if absent. */
  dkim: string | null;
  /** The domain that produced the DKIM signature (header.d / header.i), or null. */
  dkimDomain: string | null;
  spf: string | null;
  dmarc: string | null;
}

/**
 * Parse a Gmail `Authentication-Results` header value. Format (RFC 8601):
 *   `mx.google.com; dkim=pass header.i=@example.com header.s=sel; spf=pass; dmarc=pass`
 * We only need the method=result tokens plus the DKIM signing domain
 * (`header.d=` preferred, else the domain part of `header.i=`).
 */
export function parseAuthenticationResults(header: string | null): AuthenticationVerdict {
  const verdict: AuthenticationVerdict = { dkim: null, dkimDomain: null, spf: null, dmarc: null };
  if (!header) return verdict;

  const dkim = header.match(/\bdkim=([a-z]+)/i);
  if (dkim) verdict.dkim = dkim[1].toLowerCase();
  const spf = header.match(/\bspf=([a-z]+)/i);
  if (spf) verdict.spf = spf[1].toLowerCase();
  const dmarc = header.match(/\bdmarc=([a-z]+)/i);
  if (dmarc) verdict.dmarc = dmarc[1].toLowerCase();

  // Prefer the explicit signing domain `header.d=`; fall back to the domain part
  // of `header.i=` (which is typically `@domain` or `local@domain`).
  const hd = header.match(/header\.d=([^\s;]+)/i);
  if (hd) {
    verdict.dkimDomain = hd[1].toLowerCase().replace(/^@/, '');
  } else {
    const hi = header.match(/header\.i=([^\s;]+)/i);
    if (hi) verdict.dkimDomain = domainOf(`x@${hi[1].replace(/^@/, '')}`) ?? hi[1].toLowerCase().replace(/^@/, '');
  }

  return verdict;
}

/** True when `signing` aligns with `from` — equal, or one is a subdomain of the
 *  other (relaxed organizational alignment, e.g. bounces.amazon.com ↔ amazon.com). */
export function domainsAligned(signing: string | null, from: string | null): boolean {
  if (!signing || !from) return false;
  if (signing === from) return true;
  return signing.endsWith(`.${from}`) || from.endsWith(`.${signing}`);
}

/**
 * The auto-ingest gate. A discovery hit may auto-create a financial record and
 * auto-promote its sender ONLY when Gmail verified DKIM=pass AND the DKIM signing
 * domain aligns with the From-header domain. Everything else is treated as a
 * suggestion requiring explicit user promotion.
 */
export function isSenderAuthenticated(args: {
  from: string | null;
  authenticationResults: string | null;
}): boolean {
  const fromDomain = domainOf(args.from);
  if (!fromDomain) return false;
  const verdict = parseAuthenticationResults(args.authenticationResults);
  if (verdict.dkim !== 'pass') return false;
  return domainsAligned(verdict.dkimDomain, fromDomain);
}
