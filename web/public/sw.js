/*
 * Ansa's service worker. It only shows notifications and opens the conversation when one is tapped:
 * an iPhone home screen app can show notifications only through a service worker. It does not cache
 * anything or handle requests, so the app always loads fresh from the server.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const win of windows) {
        if (new URL(win.url).origin === self.location.origin && 'focus' in win) {
          return win.focus().then(() => win.navigate && win.navigate(url))
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
