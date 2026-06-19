/**
 * Cashflow service worker (issue #651). Single responsibility: receive web-push
 * events and turn them into OS notifications, then deep-link the app on click.
 *
 * The push payload is the JSON the backend `webPush.fanOutWebPush` serializes:
 *   { title, body, severity, dataJson }
 * where `dataJson` may carry a `link` (explicit deep link). When absent we fall
 * back to a per-type default derived client-side, mirroring
 * `deepLinkForNotification` in the app.
 */

self.addEventListener('install', () => {
  // Activate immediately so a freshly-registered SW handles pushes without a
  // reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function deepLinkFromPayload(payload) {
  var data = (payload && payload.dataJson) || {};
  if (data && typeof data.link === 'string' && data.link) return data.link;
  if (data && typeof data.budgetId !== 'undefined') return '/budgets';
  // digest.weekly and anything else land on the dashboard.
  return '/';
}

self.addEventListener('push', function (event) {
  var payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload = { title: 'Cashflow', body: event.data.text() };
    }
  }
  var title = payload.title || 'Cashflow';
  var options = {
    body: payload.body || '',
    icon: '/favicon-192x192.png',
    badge: '/favicon-48x48.png',
    data: { link: deepLinkFromPayload(payload) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var link = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        // Focus an existing tab if one is open, navigating it to the deep link.
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if ('focus' in client) {
            if ('navigate' in client) {
              try {
                client.navigate(link);
              } catch (e) {
                /* navigate can reject cross-origin; ignore */
              }
            }
            return client.focus();
          }
        }
        // Otherwise open a new window at the deep link.
        if (self.clients.openWindow) {
          return self.clients.openWindow(link);
        }
        return undefined;
      }),
  );
});
