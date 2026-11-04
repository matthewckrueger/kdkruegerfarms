// Service worker: shows the "ding ding" notifications even when the app is closed,
// and handles the Accept / Can't buttons on the notification itself (Android).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'KDK Pickups', body: event.data?.text() }; }
  const isOffer = data.kind === 'offer';
  const options = {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data,
    silent: !!data.silent,
    requireInteraction: isOffer || data.kind === 'overdue',
    vibrate: isOffer ? [300, 120, 300, 120, 600] : [200],
    actions: isOffer ? [
      { action: 'accept', title: "✅ I'll take it" },
      { action: 'decline', title: "❌ Can't" },
    ] : [],
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'KDK Pickups', options);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'push', data }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  event.waitUntil((async () => {
    if ((event.action === 'accept' || event.action === 'decline') && data.offerToken) {
      try {
        const r = await fetch(`api/jobs/${data.jobId}/respond-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offerToken: data.offerToken, answer: event.action }),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) {
          await self.registration.showNotification('Could not answer', { body: out.error || 'Open the app to try again.', tag: data.tag });
        } else if (event.action === 'accept') {
          await self.registration.showNotification('Job is yours 👍', { body: data.title?.replace(/^.*?: /, '') || '', tag: data.tag, icon: 'icon-192.png' });
        }
      } catch {
        await self.registration.showNotification('No signal?', { body: 'Open the app to answer.', tag: data.tag });
      }
      if (event.action === 'decline') return;
    }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) { wins[0].focus(); wins[0].postMessage({ type: 'refresh' }); return; }
    await self.clients.openWindow('./');
  })());
});
