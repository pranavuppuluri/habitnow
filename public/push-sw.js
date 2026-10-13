/*
 * Pulled into the generated service worker (see workbox.importScripts in
 * vite.config.ts). Shows the reminders the self-hosted server pushes, so they
 * arrive even when HabitNow is closed, and opens the app when one is tapped.
 */

self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    // An unreadable push still has to show something: browsers require it.
  }
  event.waitUntil(
    self.registration.showNotification(message.title || 'HabitNow', {
      body: message.body || 'Time to check in on your habits.',
      // The same tag as the app's own local reminders, so one never doubles up.
      tag: message.tag || 'habitnow',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: message.url || './' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.registration.scope))
      return open ? open.focus() : self.clients.openWindow(target)
    }),
  )
})
