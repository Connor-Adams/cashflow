import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSenderAuthenticated, parseAuthenticationResults, domainOf } from './emailAuthentication';

test('domainOf extracts the lowercased domain from an address', () => {
  assert.equal(domainOf('auto-confirm@amazon.com'), 'amazon.com');
  assert.equal(domainOf('Amazon <Auto-Confirm@Amazon.COM>'), 'amazon.com');
  assert.equal(domainOf('user@mail.amazon.com'), 'mail.amazon.com');
  assert.equal(domainOf(null), null);
  assert.equal(domainOf('not-an-address'), null);
});

test('parseAuthenticationResults reads dkim result and signing domain', () => {
  const hdr =
    'mx.google.com; dkim=pass header.i=@amazon.com header.s=sel header.b=abc; spf=pass; dmarc=pass';
  const parsed = parseAuthenticationResults(hdr);
  assert.equal(parsed.dkim, 'pass');
  assert.equal(parsed.dkimDomain, 'amazon.com');
  assert.equal(parsed.dmarc, 'pass');
  assert.equal(parsed.spf, 'pass');
});

test('parseAuthenticationResults reads header.d= signing domain form', () => {
  const parsed = parseAuthenticationResults('mx.google.com; dkim=pass header.d=amazon.com; dmarc=pass');
  assert.equal(parsed.dkim, 'pass');
  assert.equal(parsed.dkimDomain, 'amazon.com');
});

test('parseAuthenticationResults handles a failing dkim', () => {
  const parsed = parseAuthenticationResults('mx.google.com; dkim=fail header.i=@evil.test; dmarc=fail');
  assert.equal(parsed.dkim, 'fail');
  assert.equal(parsed.dmarc, 'fail');
});

test('parseAuthenticationResults handles missing / null header', () => {
  const parsed = parseAuthenticationResults(null);
  assert.equal(parsed.dkim, null);
  assert.equal(parsed.dkimDomain, null);
  assert.equal(parsed.dmarc, null);
  assert.equal(parsed.spf, null);
});

test('isSenderAuthenticated requires DKIM=pass aligned with the From domain', () => {
  // Genuine Amazon mail: DKIM passes, signed by amazon.com, From amazon.com.
  assert.equal(
    isSenderAuthenticated({
      from: 'Amazon <auto-confirm@amazon.com>',
      authenticationResults: 'mx.google.com; dkim=pass header.i=@amazon.com; dmarc=pass',
    }),
    true,
  );
});

test('isSenderAuthenticated accepts an organizational-domain DKIM (subdomain alignment)', () => {
  // DKIM signed by a subdomain of the From domain (relaxed alignment).
  assert.equal(
    isSenderAuthenticated({
      from: 'Amazon <auto-confirm@amazon.com>',
      authenticationResults: 'mx.google.com; dkim=pass header.i=@bounces.amazon.com; dmarc=pass',
    }),
    true,
  );
});

test('isSenderAuthenticated rejects a spoofed From with mismatched DKIM domain', () => {
  // The exploit: From says amazon.com but the mail is DKIM-signed by attacker.com.
  assert.equal(
    isSenderAuthenticated({
      from: 'Amazon <auto-confirm@amazon.com>',
      authenticationResults: 'mx.google.com; dkim=pass header.i=@attacker.test; dmarc=fail',
    }),
    false,
  );
});

test('isSenderAuthenticated rejects when DKIM did not pass', () => {
  assert.equal(
    isSenderAuthenticated({
      from: 'Amazon <auto-confirm@amazon.com>',
      authenticationResults: 'mx.google.com; dkim=fail header.i=@amazon.com; dmarc=fail',
    }),
    false,
  );
});

test('isSenderAuthenticated rejects when there is no Authentication-Results header', () => {
  assert.equal(
    isSenderAuthenticated({ from: 'Amazon <auto-confirm@amazon.com>', authenticationResults: null }),
    false,
  );
});

test('isSenderAuthenticated rejects an unparseable From', () => {
  assert.equal(
    isSenderAuthenticated({
      from: null,
      authenticationResults: 'mx.google.com; dkim=pass header.i=@amazon.com',
    }),
    false,
  );
});
