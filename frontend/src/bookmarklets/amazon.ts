import { extractAmazonOrdersFromDom } from './scrape/amazon';
import { dispatchCapture } from './scrape/dispatch';
import { showToast } from './scrape/toast';

declare const __CFC_TOKEN__: string;
declare const __CFC_API__: string;

(async () => {
  try {
    const orders = extractAmazonOrdersFromDom(document);
    if (orders.length === 0) {
      showToast('No orders found on this page. Open Your Orders first.', 'warn');
      return;
    }
    await dispatchCapture(__CFC_API__, __CFC_TOKEN__, 'amazon', orders, 'orders');
  } catch (e) {
    showToast(`Bookmarklet error: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
})();
