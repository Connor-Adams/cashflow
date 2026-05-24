import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../src/tax/util/decimal';
import { ratesFor } from '../../src/tax/engine/brackets';
import { computeCppEmployee, computeEiEmployee } from '../../src/tax/engine/cpp-ei';

test('CPP employee at $0 employment income = $0', () => {
  const r = ratesFor(2024);
  assert.equal(computeCppEmployee(D('0'), r).toFixed(2), '0.00');
});

test('CPP employee at $30k: (30000-3500) * 0.0595', () => {
  const r = ratesFor(2024);
  const exp = D('30000').minus('3500').times('0.0595');
  assert.equal(computeCppEmployee(D('30000'), r).toFixed(2), exp.toFixed(2));
});

test('CPP employee at YMPE+ caps base contribution + adds CPP2 up to YAMPE', () => {
  const r = ratesFor(2024); // YMPE 68500, YAMPE 73200
  const base = D('68500').minus('3500').times('0.0595');
  const cpp2 = D('73200').minus('68500').times('0.04');
  const expected = base.plus(cpp2);
  assert.equal(computeCppEmployee(D('80000'), r).toFixed(2), expected.toFixed(2));
});

test('EI employee at $30k: 30000 * 0.0166', () => {
  const r = ratesFor(2024);
  assert.equal(computeEiEmployee(D('30000'), r).toFixed(2), D('30000').times('0.0166').toFixed(2));
});

test('EI employee caps at maxInsurable', () => {
  const r = ratesFor(2024);
  assert.equal(computeEiEmployee(D('100000'), r).toFixed(2), D('63200').times('0.0166').toFixed(2));
});
