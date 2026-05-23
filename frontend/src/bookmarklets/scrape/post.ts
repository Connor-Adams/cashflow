import type { CapturedOrder } from './types';

export interface PostResult {
  ok: boolean;
  status: number;
  body: {
    created?: number;
    updated?: number;
    skipped?: number;
    error?: string;
  };
}

export async function postCapture(
  apiUrl: string,
  token: string,
  vendor: string,
  orders: CapturedOrder[],
): Promise<PostResult> {
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ vendor, orders }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : 'network error' } };
  }
}
