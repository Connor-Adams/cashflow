import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptCurrencyOrDefault, markReauthIfRevoked } from './scanReceipts';
import { GoogleOAuthError } from './gmail';
import { defaultCurrency } from '../config/env';
import type { UserEmailIntegration } from '../models/UserEmailIntegration';

function fakeIntegration() {
  return {
    status: 'connected',
    statusReason: null as string | null,
    saved: 0,
    set(values: Record<string, unknown>) {
      Object.assign(this, values);
    },
    async save() {
      this.saved += 1;
    },
  };
}

test('markReauthIfRevoked flags the integration for reconnect on invalid_grant', async () => {
  const integ = fakeIntegration();
  const handled = await markReauthIfRevoked(
    integ as unknown as UserEmailIntegration,
    new GoogleOAuthError('Google refresh failed (400)', 400, 'invalid_grant'),
  );

  assert.equal(handled, true);
  assert.equal(integ.status, 'reconnect_needed');
  assert.ok((integ.statusReason ?? '').length > 0, 'a human-readable reason must be set');
  assert.equal(integ.saved, 1, 'the status change must be persisted');
});

test('markReauthIfRevoked leaves transient/other errors untouched', async () => {
  const integ = fakeIntegration();
  const handled = await markReauthIfRevoked(
    integ as unknown as UserEmailIntegration,
    new Error('network down'),
  );

  assert.equal(handled, false);
  assert.equal(integ.status, 'connected');
  assert.equal(integ.saved, 0);
});

test('receiptCurrencyOrDefault keeps an extracted currency', () => {
  assert.equal(receiptCurrencyOrDefault('USD'), 'USD');
  assert.equal(receiptCurrencyOrDefault('CAD'), 'CAD');
});

test('receiptCurrencyOrDefault falls back to the app default currency, never a hardcoded USD', () => {
  // AI extraction legitimately returns currency null; fabricating 'USD' in a
  // CAD-default app made scoreCurrencyComponent apply its -40 penalty against
  // every CAD transaction, killing otherwise-perfect receipt matches.
  assert.equal(receiptCurrencyOrDefault(null), defaultCurrency);
  assert.equal(receiptCurrencyOrDefault(undefined), defaultCurrency);
});
