/**
 * Unit tests for the mailer abstraction (issue #267).
 *
 * Coverage:
 *   - driver selection from env: 'smtp' picks SMTP, 'noop' / unknown picks Noop
 *   - incomplete SMTP config falls back to Noop
 *   - sendEmail retries transient failures up to 3 attempts with backoff
 *   - sendEmail short-circuits on PermanentMailerError
 *   - sendEmail returns ok=false on permanent recipient-invalid
 *   - sendEmail returns ok=true on first success
 *   - test driver injection works (setMailerDriverForTest)
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMailerDriverFromEnv,
  parseMailerDriver,
  PermanentMailerError,
  sendEmail,
  setMailerDriverForTest,
  type MailerDriver,
  type SendEmailOptions,
} from './mailer';

afterEach(() => {
  // Reset injected driver between tests.
  setMailerDriverForTest(null);
});

test('parseMailerDriver: smtp', () => {
  assert.equal(parseMailerDriver('smtp'), 'smtp');
  assert.equal(parseMailerDriver('SMTP'), 'smtp');
  assert.equal(parseMailerDriver('  smtp  '), 'smtp');
});

test('parseMailerDriver: defaults to noop on unknown/missing', () => {
  assert.equal(parseMailerDriver(undefined), 'noop');
  assert.equal(parseMailerDriver(''), 'noop');
  assert.equal(parseMailerDriver('sendgrid'), 'noop');
});

test('buildMailerDriverFromEnv: noop driver when MAILER_DRIVER unset', () => {
  const d = buildMailerDriverFromEnv({});
  assert.equal(d.name, 'noop');
});

test('buildMailerDriverFromEnv: smtp picks SMTP when config is complete', () => {
  const d = buildMailerDriverFromEnv({
    MAILER_DRIVER: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_FROM: 'no-reply@example.com',
  });
  assert.equal(d.name, 'smtp');
});

test('buildMailerDriverFromEnv: smtp falls back to noop on missing host', () => {
  const d = buildMailerDriverFromEnv({
    MAILER_DRIVER: 'smtp',
    SMTP_FROM: 'no-reply@example.com',
  });
  assert.equal(d.name, 'noop');
});

test('buildMailerDriverFromEnv: smtp falls back to noop on missing from', () => {
  const d = buildMailerDriverFromEnv({
    MAILER_DRIVER: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
  });
  assert.equal(d.name, 'noop');
});

class RecordingDriver implements MailerDriver {
  name = 'recording';
  calls: SendEmailOptions[] = [];
  failsRemaining = 0;
  permanentError = false;

  async send(opts: SendEmailOptions): Promise<void> {
    this.calls.push(opts);
    if (this.permanentError) {
      throw new PermanentMailerError('bad recipient');
    }
    if (this.failsRemaining > 0) {
      this.failsRemaining -= 1;
      throw new Error('transient');
    }
  }
}

test('sendEmail: success on first attempt', async () => {
  const drv = new RecordingDriver();
  setMailerDriverForTest(drv);
  const res = await sendEmail(
    { to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' },
    { backoffMs: 1 },
  );
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(drv.calls.length, 1);
});

test('sendEmail: retries 3x then gives up on transient failures', async () => {
  const drv = new RecordingDriver();
  drv.failsRemaining = 5; // more than max attempts
  setMailerDriverForTest(drv);
  const res = await sendEmail(
    { to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' },
    { backoffMs: 1 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 3);
  assert.equal(drv.calls.length, 3);
  assert.match(res.error ?? '', /transient/);
});

test('sendEmail: succeeds on retry after one failure', async () => {
  const drv = new RecordingDriver();
  drv.failsRemaining = 1;
  setMailerDriverForTest(drv);
  const res = await sendEmail(
    { to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' },
    { backoffMs: 1 },
  );
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
});

test('sendEmail: short-circuits on PermanentMailerError', async () => {
  const drv = new RecordingDriver();
  drv.permanentError = true;
  setMailerDriverForTest(drv);
  const res = await sendEmail(
    { to: 'bad', subject: 's', html: '<p>h</p>', text: 't' },
    { backoffMs: 1 },
  );
  assert.equal(res.ok, false);
  // Only one attempt — permanent errors don't retry.
  assert.equal(drv.calls.length, 1);
});

test('sendEmail: configurable backoff and maxAttempts', async () => {
  const drv = new RecordingDriver();
  drv.failsRemaining = 5;
  setMailerDriverForTest(drv);
  const res = await sendEmail(
    { to: 'a@b.com', subject: 's', html: '<p>h</p>', text: 't' },
    { backoffMs: 1, maxAttempts: 2 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 2);
});
