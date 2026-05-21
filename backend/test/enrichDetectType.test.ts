import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectTypeStage } from '../src/import/enrichment/detectTypeStage';

test('refund: narrative says refund + positive amount', () => {
  const signals = runDetectTypeStage({
    merchantRaw: 'AMAZON.COM REFUND',
    merchantClean: 'AMAZON.COM REFUND',
    amount: 42.0,
  });
  assert.equal(signals[0].fields.txnType, 'refund');
  assert.equal(signals[0].confidence, 'high');
});

test('transfer: narrative says transfer + opposite signs handled', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'TRANSFER TO CHEQUING',
    merchantClean: 'TRANSFER TO CHEQUING',
    amount: -500,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('payment: narrative says online payment + positive', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ONLINE PAYMENT THANK YOU',
    merchantClean: 'ONLINE PAYMENT THANK YOU',
    amount: 1200,
  });
  assert.equal(out[0].fields.txnType, 'payment');
});

test('fee: narrative says annual fee', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ANNUAL FEE',
    merchantClean: 'ANNUAL FEE',
    amount: -120,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('interest: interest charge narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'INTEREST CHARGE ON PURCHASES',
    merchantClean: 'INTEREST CHARGE ON PURCHASES',
    amount: -15.5,
  });
  assert.equal(out[0].fields.txnType, 'interest');
});

test('reward: cash back / reward narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'CASH BACK REWARD',
    merchantClean: 'CASH BACK REWARD',
    amount: 25,
  });
  assert.equal(out[0].fields.txnType, 'reward');
});

test('purchase: default when nothing else matches and negative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'STARBUCKS',
    merchantClean: 'STARBUCKS',
    amount: -6.5,
  });
  assert.equal(out[0].fields.txnType, 'purchase');
  assert.equal(out[0].confidence, 'medium');
});

test('unknown: positive amount with no narrative cue', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'JOE COFFEE',
    merchantClean: 'JOE COFFEE',
    amount: 100,
  });
  assert.equal(out[0].fields.txnType, 'unknown');
});
