import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySubject } from '../src/integrations/subjectFilter';

test('blocks obvious marketing subjects', () => {
  assert.equal(classifySubject('Black Friday: 50% off everything!').decision, 'block');
  assert.equal(classifySubject('Don\'t miss our weekly digest').decision, 'block');
  assert.equal(classifySubject('Exclusive deal — limited time').decision, 'block');
});

test('passes obvious receipt subjects', () => {
  assert.equal(classifySubject('Your receipt from Apple').decision, 'pass');
  assert.equal(classifySubject('Order #123-456-789 shipped').decision, 'pass');
  assert.equal(classifySubject('Payment confirmation').decision, 'pass');
  assert.equal(classifySubject('Your order has been confirmed').decision, 'pass');
});

test('passes when neither pattern matches (let AI decide)', () => {
  assert.equal(classifySubject('Welcome to our service').decision, 'pass');
  assert.equal(classifySubject('').decision, 'pass');
  assert.equal(classifySubject(null).decision, 'pass');
});

test('positive signal overrides a negative co-mention', () => {
  // Subject like "Your order — Black Friday Sale" — receipt-flavoured AND
  // marketing-flavoured. We err on the side of letting it through to AI.
  assert.equal(classifySubject('Your order — Black Friday Sale').decision, 'pass');
});

test('blocks review and survey requests', () => {
  assert.equal(classifySubject('Rate your recent purchase').decision, 'block');
  assert.equal(classifySubject('Please complete this survey').decision, 'block');
  assert.equal(classifySubject('Thanks for reviewing your order').decision, 'block');
});
