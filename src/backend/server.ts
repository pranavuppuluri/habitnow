import type { AppData, Area, Habit, User } from '../lib/types'
import { AuthError, type Backend } from './types'

/**
 * Self-hosted backend. Talks to server/habitnow-server.mjs, which serves this
 * build and keeps every account and habit on its own disk - so any browser on
 * the network that signs in sees the same data. Chosen at build time with
 * `npm run build:pi` (VITE_BACKEND=server); the session rides in an HttpOnly
 * cookie the server sets.
 */

export const serverConfigured = import.meta.env.VITE_BACKEND === 'server'

// Relative, so the app works whether it is served from / or a subpath.
const api = (route: string) => `api/${route}`

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(api(route), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error('Cannot reach the HabitNow server. Check that it is running and you are on its network.')
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    const message = json.error ?? `The server answered ${res.status}.`
    throw res.status === 400 || res.status === 401 || res.status === 409 ? new AuthError(message) : new Error(message)
  }
  return json
}

export const serverBackend: Backend = {
  mode: 'server',

  async currentUser() {
    return (await call<{ user: User | null }>('GET', 'me')).user
  },

  async signUp(email, password, name) {
    return (await call<{ user: User }>('POST', 'signup', { email, password, name })).user
  },

  async signIn(email, password) {
    return (await call<{ user: User }>('POST', 'signin', { email, password })).user
  },

  async signOut() {
    await call('POST', 'signout')
  },

  async load() {
    return call<AppData>('GET', 'data')
  },

  async createHabit(_user, draft, position) {
    return call<Habit>('POST', 'habits', { draft, position })
  },

  async updateHabit(_user, id, patch) {
    await call('PATCH', `habits/${id}`, { patch })
  },

  async deleteHabit(_user, id) {
    await call('DELETE', `habits/${id}`)
  },

  async reorderHabits(_user, ordered) {
    await call('POST', 'habits/reorder', { ordered })
  },

  async createArea(_user, name, position) {
    return call<Area>('POST', 'areas', { name, position })
  },

  async deleteArea(_user, id) {
    await call('DELETE', `areas/${id}`)
  },

  async setEntry(_user, habitId, date, patch) {
    await call('PUT', 'entries', { habitId, date, patch })
  },

  push: {
    async publicKey() {
      return (await call<{ publicKey: string }>('GET', 'push/key')).publicKey
    },
    async subscribe(subscription, timeZone) {
      await call('POST', 'push/subscribe', { subscription, timeZone })
    },
    async unsubscribe(endpoint) {
      await call('POST', 'push/unsubscribe', { endpoint })
    },
    test() {
      return call<{ sent: number; devices: number }>('POST', 'push/test')
    },
  },
}
