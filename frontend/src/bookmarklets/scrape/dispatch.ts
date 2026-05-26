import { postCapture } from './post';
import { showToast } from './toast';
import type { CapturedOrder } from './types';

/**
 * Try the direct POST first; if the vendor page's CSP blocks the cross-origin
 * fetch (postCapture surfaces this as status 0), copy the payload to the
 * clipboard and tell the user to paste it into the Cashflow Settings → Imports
 * UI. Last-resort fallback stashes the payload on `window` so it can be copied
 * from devtools.
 */
export async function dispatchCapture(
  apiUrl: string,
  token: string,
  vendor: 'amazon' | 'apple',
  orders: CapturedOrder[],
  successNoun: string,
): Promise<void> {
  const res = await postCapture(apiUrl, token, vendor, orders);
  if (res.status === 0) {
    await fallbackToClipboard(vendor, orders, successNoun);
    return;
  }
  if (res.status === 401) {
    showToast('Cashflow token rejected. Re-mint in Settings.', 'error');
    return;
  }
  if (!res.ok) {
    showToast(`Capture failed (${res.status}): ${res.body.error ?? 'unknown'}`, 'error');
    return;
  }
  const { created = 0, updated = 0, skipped = 0 } = res.body;
  showToast(
    `Captured ${orders.length} ${successNoun}. ${created} new, ${updated} updated, ${skipped} unchanged.`,
    'success',
  );
}

async function fallbackToClipboard(
  vendor: string,
  orders: CapturedOrder[],
  successNoun: string,
): Promise<void> {
  const payload = JSON.stringify({ vendor, orders });
  try {
    await navigator.clipboard.writeText(payload);
    showToast(
      `Network blocked by this site. Copied ${orders.length} ${successNoun} to clipboard — paste into Cashflow → Settings → Imports → Paste captured orders.`,
      'warn',
    );
    return;
  } catch {
    // Clipboard API can refuse if the page denies the permission. Stash the
    // payload on window so the user can copy it from devtools as a last resort.
    (window as unknown as { __cashflowCapture?: string }).__cashflowCapture = payload;
    showToast(
      `Network blocked and clipboard write refused. Run copy(window.__cashflowCapture) in DevTools, then paste into Cashflow → Settings → Imports.`,
      'error',
    );
  }
}
