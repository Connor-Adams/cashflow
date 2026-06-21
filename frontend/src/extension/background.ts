/// <reference types="chrome" />
interface StoredConfig {
  apiBase?: string;
  token?: string;
}

async function getConfig(): Promise<StoredConfig> {
  return new Promise((resolve) => chrome.storage.sync.get(['apiBase', 'token'], (v) => resolve(v as StoredConfig)));
}

function setBadge(text: string, color: string): void {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

chrome.runtime.onMessage.addListener(
  (msg: { type?: string; vendor?: string; orders?: unknown[] }, _sender, sendResponse) => {
    if (msg?.type !== 'CASHFLOW_CAPTURE') return undefined;
    void (async () => {
      try {
        const { apiBase, token } = await getConfig();
        if (!apiBase || !token) {
          setBadge('SET', '#b45309'); // prompt the user to open Options
          return;
        }
        const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/capture/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ vendor: msg.vendor ?? 'amazon', orders: msg.orders ?? [], client: 'extension' }),
        });
        if (res.status === 401 || res.status === 403) {
          setBadge('AUTH', '#dc2626');
          return;
        }
        if (!res.ok) {
          setBadge('ERR', '#dc2626');
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { created?: number; matchSuggested?: number };
        // Show the server's actual inserted count, not the scraped payload length —
        // re-visiting Orders re-sends already-captured orders that dedupe to created:0.
        setBadge(String(body.created ?? (msg.orders ?? []).length), '#16a34a');
        console.info('[cashflow] captured', body);
      } catch (e) {
        setBadge('ERR', '#dc2626');
        console.error('[cashflow] capture failed', e);
      } finally {
        sendResponse(null); // keep SW alive until async work settles
      }
    })();
    return true; // async response → hold the channel open
  },
);
