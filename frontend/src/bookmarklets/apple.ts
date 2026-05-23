import { extractApplePurchasesFromDom } from './scrape/apple';
import { postCapture } from './scrape/post';
import { showToast } from './scrape/toast';

declare const __CFC_TOKEN__: string;
declare const __CFC_API__: string;

(async () => {
  try {
    const orders = extractApplePurchasesFromDom(document);
    if (orders.length === 0) {
      showToast('No purchases found. Open reportaproblem.apple.com first.', 'warn');
      return;
    }
    const res = await postCapture(__CFC_API__, __CFC_TOKEN__, 'apple', orders);
    if (res.status === 401) {
      showToast('Cashflow token rejected. Re-mint in Settings.', 'error');
      return;
    }
    if (!res.ok) {
      showToast(`Capture failed (${res.status}): ${res.body.error ?? 'unknown'}`, 'error');
      return;
    }
    const { created = 0, updated = 0, skipped = 0 } = res.body;
    showToast(`Captured ${orders.length} purchases. ${created} new, ${updated} updated, ${skipped} unchanged.`, 'success');
  } catch (e) {
    showToast(`Bookmarklet error: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
})();
