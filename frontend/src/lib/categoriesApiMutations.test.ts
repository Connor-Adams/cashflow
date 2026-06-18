import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './api';
import { createCategory, renameCategory, reparentCategory, deleteCategory } from './categoriesApi';

describe('categoriesApi mutations', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('createCategory posts name + parentId', async () => {
    const spy = vi.spyOn(api, 'postJson').mockResolvedValue({ id: 5 } as never);
    await createCategory('Internet', 1);
    expect(spy).toHaveBeenCalledWith('/api/categories', { name: 'Internet', parentId: 1 });
  });

  it('renameCategory patches name', async () => {
    const spy = vi.spyOn(api, 'patchJson').mockResolvedValue({ id: 5 } as never);
    await renameCategory(5, 'WiFi');
    expect(spy).toHaveBeenCalledWith('/api/categories/5', { name: 'WiFi' });
  });

  it('reparentCategory patches the reparent endpoint', async () => {
    const spy = vi.spyOn(api, 'patchJson').mockResolvedValue({ id: 5 } as never);
    await reparentCategory(5, 2);
    expect(spy).toHaveBeenCalledWith('/api/categories/5/reparent', { parentId: 2 });
  });

  it('deleteCategory hits the delete endpoint', async () => {
    const spy = vi.spyOn(api, 'deleteReq').mockResolvedValue(undefined);
    await deleteCategory(5);
    expect(spy).toHaveBeenCalledWith('/api/categories/5');
  });
});
