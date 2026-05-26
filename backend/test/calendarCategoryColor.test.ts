import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_CATEGORY_COLOR,
  categoryColorForType,
} from '../src/calendar/categoryColor';
import { PLANNED_EVENT_TYPES } from '../src/models/PlannedEvent';

test('EVENT_CATEGORY_COLOR maps every PlannedEventType', () => {
  for (const t of PLANNED_EVENT_TYPES) {
    assert.ok(
      EVENT_CATEGORY_COLOR[t],
      `missing color mapping for type '${t}'`,
    );
  }
});

test('EVENT_CATEGORY_COLOR yields non-empty Tailwind palette names', () => {
  for (const t of PLANNED_EVENT_TYPES) {
    const color = EVENT_CATEGORY_COLOR[t];
    assert.equal(typeof color, 'string');
    assert.ok(color.length > 0);
    // Tailwind v4 default palette keys are lowercase, hyphen-free.
    assert.match(color, /^[a-z]+$/);
  }
});

test('categoryColorForType returns the mapped value', () => {
  assert.equal(categoryColorForType('income'), 'emerald');
  assert.equal(categoryColorForType('expense'), 'rose');
  assert.equal(categoryColorForType('savings'), 'violet');
});
