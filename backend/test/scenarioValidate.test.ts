/**
 * Unit tests for the pure scenario-input validator (issue #213). Exercises
 * the request-body validation for POST /api/financial-scenarios without
 * touching the database — mirrors the validatePlannedEventInput pattern.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateScenarioInput,
  type NormalizedScenarioInput,
} from '../src/routes/financialScenarios';

function ok(raw: Record<string, unknown>): NormalizedScenarioInput {
  const res = validateScenarioInput(raw);
  assert.equal(res.ok, true, `expected ok, got: ${JSON.stringify(res)}`);
  // narrow
  if (!res.ok) throw new Error('unreachable');
  return res.value;
}

function bad(raw: Record<string, unknown>): { status: number; error: string } {
  const res = validateScenarioInput(raw);
  assert.equal(res.ok, false, `expected error, got ok: ${JSON.stringify(res)}`);
  if (res.ok) throw new Error('unreachable');
  return { status: res.status, error: res.error };
}

test('accepts a minimal valid scenario (name + empty assumptions)', () => {
  const v = ok({ name: 'My scenario', assumptions: [] });
  assert.equal(v.name, 'My scenario');
  assert.deepEqual(v.assumptions, []);
  assert.equal(v.horizonDays, 90); // default
  assert.equal(v.currency, null); // default → resolved server-side
});

test('trims the name and rejects empty / missing', () => {
  assert.equal(ok({ name: '  Trip  ', assumptions: [] }).name, 'Trip');
  assert.equal(bad({ assumptions: [] }).status, 400);
  assert.equal(bad({ name: '   ', assumptions: [] }).status, 400);
});

test('rejects a non-array assumptions field', () => {
  assert.equal(bad({ name: 'x', assumptions: 'nope' }).status, 400);
});

test('defaults assumptions to empty when omitted', () => {
  assert.deepEqual(ok({ name: 'x' }).assumptions, []);
});

test('accepts income_pct / expense_pct with finite pct >= -1', () => {
  const v = ok({
    name: 'x',
    assumptions: [
      { kind: 'income_pct', pct: -0.3 },
      { kind: 'expense_pct', pct: 0.1 },
    ],
  });
  assert.equal(v.assumptions.length, 2);
});

test('rejects income_pct below -1 (cannot remove more than all income)', () => {
  assert.equal(
    bad({ name: 'x', assumptions: [{ kind: 'income_pct', pct: -1.5 }] }).status,
    400,
  );
});

test('rejects non-finite pct', () => {
  assert.equal(
    bad({
      name: 'x',
      assumptions: [{ kind: 'income_pct', pct: 'NaN' }],
    }).status,
    400,
  );
});

test('accepts savings_monthly with non-negative amount', () => {
  const v = ok({
    name: 'x',
    assumptions: [{ kind: 'savings_monthly', amount: 2000 }],
  });
  assert.equal(v.assumptions[0].kind, 'savings_monthly');
});

test('rejects negative savings_monthly amount', () => {
  assert.equal(
    bad({ name: 'x', assumptions: [{ kind: 'savings_monthly', amount: -5 }] })
      .status,
    400,
  );
});

test('accepts one_off with ISO date, non-negative amount and valid direction', () => {
  const v = ok({
    name: 'x',
    assumptions: [
      { kind: 'one_off', date: '2026-07-01', amount: 25000, direction: 'out' },
    ],
  });
  const a = v.assumptions[0];
  assert.equal(a.kind, 'one_off');
  if (a.kind === 'one_off') {
    assert.equal(a.date, '2026-07-01');
    assert.equal(a.direction, 'out');
  }
});

test('rejects one_off with a malformed date', () => {
  assert.equal(
    bad({
      name: 'x',
      assumptions: [
        { kind: 'one_off', date: '07/01/2026', amount: 10, direction: 'out' },
      ],
    }).status,
    400,
  );
});

test('rejects one_off with bad direction', () => {
  assert.equal(
    bad({
      name: 'x',
      assumptions: [
        { kind: 'one_off', date: '2026-07-01', amount: 10, direction: 'sideways' },
      ],
    }).status,
    400,
  );
});

test('rejects an unknown assumption kind', () => {
  assert.equal(
    bad({ name: 'x', assumptions: [{ kind: 'teleport', amount: 1 }] }).status,
    400,
  );
});

test('horizonDays must be 1..365', () => {
  assert.equal(ok({ name: 'x', horizonDays: 30 }).horizonDays, 30);
  assert.equal(bad({ name: 'x', horizonDays: 0 }).status, 400);
  assert.equal(bad({ name: 'x', horizonDays: 400 }).status, 400);
  assert.equal(bad({ name: 'x', horizonDays: 'soon' }).status, 400);
});

test('currency normalizes to uppercase 3-letter or rejects', () => {
  assert.equal(ok({ name: 'x', currency: 'usd' }).currency, 'USD');
  assert.equal(bad({ name: 'x', currency: 'US' }).status, 400);
  assert.equal(bad({ name: 'x', currency: 'DOLLARS' }).status, 400);
});

test('coerces a numeric-string pct', () => {
  const v = ok({
    name: 'x',
    assumptions: [{ kind: 'income_pct', pct: '-0.5' }],
  });
  const a = v.assumptions[0];
  if (a.kind === 'income_pct') assert.equal(a.pct, -0.5);
});
