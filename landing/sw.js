// Kill-switch worker. unhuman.in used to serve the HabitNow PWA, whose service
// worker precached its app shell and would otherwise keep serving it in place
// of the new launcher. This replaces that worker: it clears every cache,
// unregisters itself, and reloads open tabs onto the fresh page.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
      await self.registration.unregister()
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const client of clients) client.navigate(client.url)
    })(),
  )
})
