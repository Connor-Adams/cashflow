/// <reference types="chrome" />
import { extractAmazonOrdersFromDom } from '../bookmarklets/scrape/amazon';

// Content scripts run in the page's origin and are subject to its CORS policy,
// so we never POST from here — we hand the scraped orders to the background
// service worker, whose fetch (with granted host permission) is not CORS-bound.
const orders = extractAmazonOrdersFromDom(document);
if (orders.length > 0) {
  chrome.runtime.sendMessage({ type: 'CASHFLOW_CAPTURE', vendor: 'amazon', orders });
}
