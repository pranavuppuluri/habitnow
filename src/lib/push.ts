import type { PushApi } from '../backend/types'

/**
 * Reminders that arrive with the app closed. The self-hosted server keeps each
 * browser's push subscription and sends a Web Push when a reminder comes due;
 * the service worker (public/push-sw.js) shows it. Only a backend with a server
 * behind it offers this, and browsers only allow it over HTTPS, on iOS only
 * once the app is added to the home screen.
 */

export function pushSupported(push: PushApi | undefined): push is PushApi {
  return (
    push !== undefined &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  )
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false
  const view = new Uint8Array(a)
  return view.every((byte, i) => byte === b[i])
}

/** The service worker, or null if none takes control within a few seconds (dev, or blocked). */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

/**
 * Subscribes this browser (or refreshes an existing subscription, which also
 * updates its time zone) and registers it with the server. Needs notification
 * permission first. Returns false when push isn't available here.
 */
export async function subscribeToPush(push: PushApi): Promise<boolean> {
  const reg = await worker()
  if (!reg) return false
  const key = keyBytes(await push.publicKey())
  let sub = await reg.pushManager.getSubscription()
  // A subscription made for another server key can't be reused.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await push.subscribe(sub.toJSON(), Intl.DateTimeFormat().resolvedOptions().timeZone)
  return true
}

/** Stops pushes to this browser, before signing out, so the next account here doesn't get them. */
export async function unsubscribeFromPush(push: PushApi): Promise<void> {
  const reg = await worker()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await push.unsubscribe(sub.endpoint).catch(() => {})
  await sub.unsubscribe().catch(() => {})
}
