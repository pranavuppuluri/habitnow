import { EMPTY_DATA, type AppData, type Area, type Habit, type User } from '../lib/types'
import { entryKey } from '../lib/stats'
import { storageKey } from '../lib/storage'
import { AuthError, type Backend } from './types'

/**
 * Device-only backend. Accounts and habits live in this browser's localStorage,
 * so they never leave the machine and never sync. Passwords are salted and
 * hashed rather than stored in the clear, but anything in localStorage is
 * readable by anyone with access to the device — this is a convenience lock,
 * not real security. Configure Supabase for accounts that actually travel.
 */

const USERS_KEY = storageKey('users.v1')
const SESSION_KEY = storageKey('session.v1')
const dataKey = (userId: string) => storageKey(`data.v1.${userId}`)

interface StoredUser {
  id: string
  email: string
  name: string
  salt: string
  hash: string
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private browsing or a full quota: the session simply won't persist.
  }
}

function uid(): string {
  return crypto.randomUUID()
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hash(password: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${password}`)
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

function users(): Record<string, StoredUser> {
  return readJSON<Record<string, StoredUser>>(USERS_KEY, {})
}

function publicUser(u: StoredUser): User {
  return { id: u.id, email: u.email, name: u.name }
}

function readData(userId: string): AppData {
  const data = readJSON<AppData>(dataKey(userId), EMPTY_DATA)
  return { habits: data.habits ?? [], areas: data.areas ?? [], entries: data.entries ?? {} }
}

function writeData(userId: string, data: AppData): void {
  writeJSON(dataKey(userId), data)
}

export const localBackend: Backend = {
  mode: 'device',

  async currentUser() {
    const id = localStorage.getItem(SESSION_KEY)
    if (!id) return null
    const found = Object.values(users()).find((u) => u.id === id)
    return found ? publicUser(found) : null
  },

  async signUp(email, password, name) {
    const key = email.trim().toLowerCase()
    if (!key.includes('@')) throw new AuthError('Enter a valid email address.')
    if (password.length < 6) throw new AuthError('Use at least 6 characters for the password.')
    const all = users()
    if (all[key]) throw new AuthError('An account already exists on this device for that email.')
    const salt = uid()
    const stored: StoredUser = {
      id: uid(),
      email: key,
      name: name.trim() || key.split('@')[0],
      salt,
      hash: await hash(password, salt),
    }
    all[key] = stored
    writeJSON(USERS_KEY, all)
    writeData(stored.id, EMPTY_DATA)
    localStorage.setItem(SESSION_KEY, stored.id)
    return publicUser(stored)
  },

  async signIn(email, password) {
    const key = email.trim().toLowerCase()
    const stored = users()[key]
    if (!stored) throw new AuthError('No account on this device uses that email.')
    if ((await hash(password, stored.salt)) !== stored.hash) throw new AuthError('That password does not match.')
    localStorage.setItem(SESSION_KEY, stored.id)
    return publicUser(stored)
  },

  async signOut() {
    localStorage.removeItem(SESSION_KEY)
  },

  async load(user) {
    return readData(user.id)
  },

  async replaceData(user, data) {
    writeData(user.id, data)
  },

  async createHabit(user, draft, position) {
    const data = readData(user.id)
    const habit: Habit = {
      ...draft,
      id: uid(),
      archived: false,
      position,
      createdAt: new Date().toISOString(),
    }
    data.habits.push(habit)
    writeData(user.id, data)
    return habit
  },

  async updateHabit(user, id, patch) {
    const data = readData(user.id)
    data.habits = data.habits.map((h) => (h.id === id ? { ...h, ...patch } : h))
    writeData(user.id, data)
  },

  async deleteHabit(user, id) {
    const data = readData(user.id)
    data.habits = data.habits.filter((h) => h.id !== id)
    for (const key of Object.keys(data.entries)) {
      if (data.entries[key].habitId === id) delete data.entries[key]
    }
    writeData(user.id, data)
  },

  async reorderHabits(user, ordered) {
    const data = readData(user.id)
    const map = new Map(ordered.map((o) => [o.id, o.position]))
    data.habits = data.habits.map((h) => (map.has(h.id) ? { ...h, position: map.get(h.id)! } : h))
    writeData(user.id, data)
  },

  async createArea(user, name, position) {
    const data = readData(user.id)
    const area: Area = { id: uid(), name, position }
    data.areas.push(area)
    writeData(user.id, data)
    return area
  },

  async deleteArea(user, id) {
    const data = readData(user.id)
    data.areas = data.areas.filter((a) => a.id !== id)
    data.habits = data.habits.map((h) => (h.areaId === id ? { ...h, areaId: null } : h))
    writeData(user.id, data)
  },

  async setEntry(user, habitId, date, patch) {
    const data = readData(user.id)
    const key = entryKey(habitId, date)
    const existing = data.entries[key]
    const next = {
      id: key,
      habitId,
      date,
      value: patch.value ?? existing?.value ?? 0,
      skipped: patch.skipped ?? existing?.skipped ?? false,
      note: patch.note ?? existing?.note ?? '',
    }
    if (next.value === 0 && !next.skipped && next.note === '') delete data.entries[key]
    else data.entries[key] = next
    writeData(user.id, data)
  },
}
