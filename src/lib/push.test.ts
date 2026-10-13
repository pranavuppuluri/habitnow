/**
 * The browser half of push reminders: subscribing with the server's key,
 * reusing a subscription when it still fits, and replacing it when the server's
 * key has changed. The service worker and PushManager are stand-ins.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { PushApi } from '../backend/types'
import { pushSupported, subscribeToPush, unsubscribeFromPush } from './push'

const KEY = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i))
const KEY_B64URL = btoa(String.fromCharCode(...KEY)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function fakeSubscription(endpoint: string, key: Uint8Array) {
  return {
    endpoint,
    options: { applicationServerKey: key.buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  }
}

let current: ReturnType<typeof fakeSubscription> | null
const pushManager = {
  getSubscription: vi.fn(async () => current),
  subscribe: vi.fn(async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
    current = fakeSubscription('https://push.example/new', applicationServerKey)
    return current
  }),
}

function server(): PushApi & { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> } {
  return {
    publicKey: vi.fn(async () => KEY_B64URL),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    test: vi.fn(async () => ({ sent: 1, devices: 1 })),
  }
}

beforeEach(() => {
  current = null
  pushManager.getSubscription.mockClear()
  pushManager.subscribe.mockClear()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('PushManager', function PushManager() {})
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

test('push needs a server that sends it, HTTPS and a service worker', () => {
  expect(pushSupported(undefined)).toBe(false)
  expect(pushSupported(server())).toBe(true)
  vi.stubGlobal('isSecureContext', false)
  expect(pushSupported(server())).toBe(false)
})

test('subscribes with the server key and registers this browser and its time zone', async () => {
  const api = server()
  expect(await subscribeToPush(api)).toBe(true)
  const { applicationServerKey, userVisibleOnly } = pushManager.subscribe.mock.calls[0][0] as {
    applicationServerKey: Uint8Array
    userVisibleOnly: boolean
  }
  expect(userVisibleOnly).toBe(true)
  expect([...applicationServerKey]).toEqual([...KEY])
  expect(api.subscribe).toHaveBeenCalledWith(
    { endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } },
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
})

test('reuses a subscription made for the same key, and replaces one made for another', async () => {
  current = fakeSubscription('https://push.example/kept', KEY)
  await subscribeToPush(server())
  expect(pushManager.subscribe).not.toHaveBeenCalled()

  const stale = fakeSubscription('https://push.example/stale', new Uint8Array(65).fill(9))
  current = stale
  const api = server()
  await subscribeToPush(api)
  expect(stale.unsubscribe).toHaveBeenCalled()
  expect(api.subscribe.mock.calls[0][0]).toMatchObject({ endpoint: 'https://push.example/new' })
})

test('gives up quietly when no service worker takes control', async () => {
  vi.useFakeTimers()
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: new Promise(() => {}) } })
  const result = subscribeToPush(server())
  await vi.advanceTimersByTimeAsync(9000)
  expect(await result).toBe(false)
})

test('signing out stops pushes to this browser on both ends', async () => {
  current = fakeSubscription('https://push.example/mine', KEY)
  const sub = current
  const api = server()
  await unsubscribeFromPush(api)
  expect(api.unsubscribe).toHaveBeenCalledWith('https://push.example/mine')
  expect(sub.unsubscribe).toHaveBeenCalled()
})
