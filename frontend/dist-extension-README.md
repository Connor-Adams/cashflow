# Cashflow Amazon Capture — install (load unpacked)

1. Build it: from the repo root run `yarn workspace frontend run build:extension`.
   This produces `frontend/dist-extension/`.
2. Open Chrome → `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the `frontend/dist-extension/` folder.
5. In Cashflow → **Settings → Imports**, mint a capture token.
6. Right-click the extension icon → **Options**. Paste your Cashflow URL and the
   token, click **Save & grant access**, approve the permission prompt.
7. Open Amazon → **Your Orders**. The badge shows the number of captured orders.

Re-mint a token and revoke the old one any time to rotate access. Chrome will
ask to "disable developer-mode extensions" on startup — that is expected for an
unpacked extension; leave it enabled.
