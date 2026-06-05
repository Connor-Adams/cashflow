import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { ratesFor } from './brackets';
import {
  grossUpEligible,
  grossUpNonEligible,
  dtcFederal,
  dtcOntario,
} from './dividends';

test('eligible dividend $1000 grosses up to $1380', () => {
  const r = ratesFor(2024);
  assert.equal(grossUpEligible(D('1000'), r).toFixed(2), '1380.00');
});

test('non-eligible dividend $1000 grosses up to $1150', () => {
  const r = ratesFor(2024);
  assert.equal(grossUpNonEligible(D('1000'), r).toFixed(2), '1150.00');
});

test('federal DTC on $1380 grossed-up eligible = 1380 * 0.150198', () => {
  const r = ratesFor(2024);
  assert.equal(
    dtcFederal(D('1380'), 'eligible', r).toFixed(4),
    D('1380').times('0.150198').toFixed(4)
  );
});

test('Ontario DTC on $1380 grossed-up eligible = 1380 * 0.10', () => {
  const r = ratesFor(2024);
  assert.equal(dtcOntario(D('1380'), 'eligible', r).toFixed(2), '138.00');
});
