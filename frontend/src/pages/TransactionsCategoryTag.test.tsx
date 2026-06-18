import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as catApi from '../lib/categoriesApi';

// The helper lives in a dedicated module; the test imports from there.
import { resolveCategoryPatch, categoryFieldChanged } from './transactionsCategory';

describe('resolveCategoryPatch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves a path to an id and returns a categoryOverrideId patch', async () => {
    vi.spyOn(catApi, 'resolveCategoryPath').mockResolvedValue({ id: 7, name: 'Internet', path: 'Work / Internet', createdIds: [] });
    const patch = await resolveCategoryPatch('Work / Internet');
    expect(patch).toEqual({ categoryOverrideId: 7 });
  });

  it('empty input clears the override', async () => {
    // FIX 3: assert resolveCategoryPath is NOT called on the short-circuit path
    const spy = vi.spyOn(catApi, 'resolveCategoryPath');
    const patch = await resolveCategoryPatch('');
    expect(patch).toEqual({ categoryOverrideId: null });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('categoryFieldChanged', () => {
  // FIX 4: lock the conditional-patch behavior

  it('returns false when current equals the baseline string', () => {
    expect(categoryFieldChanged('Groceries', 'Groceries')).toBe(false);
  });

  it('returns false when both current and baseline are empty / null', () => {
    expect(categoryFieldChanged('', null)).toBe(false);
    expect(categoryFieldChanged('', '')).toBe(false);
  });

  it('returns true when current differs from the baseline', () => {
    expect(categoryFieldChanged('Internet', 'Groceries')).toBe(true);
  });

  it('returns true when current is set but baseline is null (new tag)', () => {
    expect(categoryFieldChanged('Internet', null)).toBe(true);
  });

  it('returns true when current is cleared but baseline had a value (tag removed)', () => {
    expect(categoryFieldChanged('', 'Groceries')).toBe(true);
  });
});
