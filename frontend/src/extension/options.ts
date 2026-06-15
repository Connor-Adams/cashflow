/// <reference types="chrome" />
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const apiBaseEl = $<HTMLInputElement>('apiBase');
const tokenEl = $<HTMLInputElement>('token');
const statusEl = $<HTMLElement>('status');

function originPattern(apiBase: string): string {
  return `${new URL(apiBase).origin}/*`;
}

chrome.storage.sync.get(['apiBase', 'token'], (v) => {
  apiBaseEl.value = (v as { apiBase?: string }).apiBase ?? '';
  tokenEl.value = (v as { token?: string }).token ?? '';
});

$('save').addEventListener('click', () => {
  const apiBase = apiBaseEl.value.trim().replace(/\/$/, '');
  const token = tokenEl.value.trim();
  if (!apiBase || !token) {
    statusEl.textContent = 'Both fields are required.';
    return;
  }
  let pattern: string;
  try {
    pattern = originPattern(apiBase);
  } catch {
    statusEl.textContent = 'API base must be a full URL (https://…).';
    return;
  }
  chrome.permissions.request({ origins: [pattern] }, (granted) => {
    if (!granted) {
      statusEl.textContent = 'Permission denied — capture cannot reach your Cashflow.';
      return;
    }
    chrome.storage.sync.set({ apiBase, token }, () => {
      statusEl.textContent = 'Saved. Open Amazon → Your Orders to capture.';
    });
  });
});

$('test').addEventListener('click', () => {
  const apiBase = apiBaseEl.value.trim().replace(/\/$/, '');
  const token = tokenEl.value.trim();
  if (!apiBase || !token) {
    statusEl.textContent = 'Enter API base and token first.';
    return;
  }
  let pattern: string;
  try {
    pattern = originPattern(apiBase);
  } catch {
    statusEl.textContent = 'API base must be a full URL (https://…).';
    return;
  }
  chrome.permissions.contains({ origins: [pattern] }, (granted) => {
    if (!granted) {
      statusEl.textContent = 'Click "Save & grant access" first to authorize this URL.';
      return;
    }
    void fetch(`${apiBase}/api/capture/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vendor: 'amazon', orders: [] }),
    })
      .then((r) => {
        // A VALID token rejects the empty orders array with 400; 401 means bad token.
        statusEl.textContent = r.status === 401 ? 'Token rejected (401).' : 'Token accepted ✓';
      })
      .catch((e) => {
        statusEl.textContent = `Could not reach API: ${e instanceof Error ? e.message : String(e)}`;
      });
  });
});
