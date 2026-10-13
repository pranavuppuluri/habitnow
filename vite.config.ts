import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Relative base so the same build works on GitHub Pages project sites
// (username.github.io/repo), Netlify, Vercel, or a plain file server.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      // A tracker gets opened daily; waiting for every tab to close before an
      // update lands would strand people on old builds for weeks.
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg', 'icons/icon-180.png'],
      manifest: {
        name: 'HabitNow',
        short_name: 'HabitNow',
        description: 'Build habits one day at a time. Track streaks, see your ledger of days.',
        // Relative so an install from a repo subpath scopes to that subpath.
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#15181f',
        theme_color: '#15181f',
        categories: ['productivity', 'lifestyle', 'health'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Android crops this to its own shape, so it carries extra padding.
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Shows reminders the self-hosted server pushes; harmless elsewhere.
        importScripts: ['push-sw.js'],
        // Every route is the same SPA shell; hand it back for any navigation.
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // The stylesheet can revalidate in the background - it is small and
            // changes when the font list does.
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-css' },
          },
          {
            // The font files themselves are immutable and worth keeping a year.
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-files',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Off in dev: a service worker caching a dev server is only confusing.
        enabled: false,
      },
    }),
  ],
})
