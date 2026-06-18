import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as catApi from '../lib/categoriesApi';

// The helper lives in a dedicated module; the test imports from there.
import { resolveCategoryPatch } from './transactionsCategory';

describe('resolveCategoryPatch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves a path to an id and returns a categoryOverrideId patch', async () => {
    vi.spyOn(catApi, 'resolveCategoryPath').mockResolvedValue({ id: 7, name: 'Internet', path: 'Work / Internet', createdIds: [] });
    const patch = await resolveCategoryPatch('Work / Internet');
    expect(patch).toEqual({ categoryOverrideId: 7 });
  });

  it('empty input clears the override', async () => {
    const patch = await resolveCategoryPatch('');
    expect(patch).toEqual({ categoryOverrideId: null });
  });
});
