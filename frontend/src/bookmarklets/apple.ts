import { extractApplePurchasesFromDom } from './scrape/apple';
import { dispatchCapture } from './scrape/dispatch';
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
    await dispatchCapture(__CFC_API__, __CFC_TOKEN__, 'apple', orders, 'purchases');
  } catch (e) {
    showToast(`Bookmarklet error: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
})();
