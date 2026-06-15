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

chrome.runtime.onMessage.addListener((msg: { type?: string; vendor?: string; orders?: unknown[] }) => {
  if (msg?.type !== 'CASHFLOW_CAPTURE') return;
  void (async () => {
    const { apiBase, token } = await getConfig();
    if (!apiBase || !token) {
      setBadge('SET', '#b45309'); // prompt the user to open Options
      return;
    }
    try {
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
      setBadge(String((msg.orders ?? []).length), '#16a34a');
      console.info('[cashflow] captured', body);
    } catch (e) {
      setBadge('ERR', '#dc2626');
      console.error('[cashflow] capture failed', e);
    }
  })();
});
