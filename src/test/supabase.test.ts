/**
 * The cloud backend, driven against an in-memory fake of the Supabase client.
 *
 * The fake records every query the backend builds (table, operation, payload,
 * filters) and answers from a response table, so each test can check exactly
 * what would have been sent over the wire. Nothing here talks to a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entryKey } from '../lib/stats'
import type { User } from '../lib/types'

interface Op {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete'
  payload?: unknown
  options?: unknown
  filters: [string, string, unknown][]
}

interface Result {
  data: unknown
  error: { message: string } | null
}

const fake = vi.hoisted(() => {
  const ops: Op[] = []
  /** Keyed `${table}.${op}`; anything not listed answers with an empty success. */
  const responses: Record<string, Result> = {}
  const auth = {
    getSession: vi.fn(),
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  }

  function from(table: string) {
    const op: Op = { table, op: 'select', filters: [] }
    ops.push(op)
    // supabase-js builders are thenables: the query runs when awaited.
    const q = {
      select: () => q,
      order: () => q,
      single: () => q,
      insert: (payload: unknown) => ((op.op = 'insert'), (op.payload = payload), q),
      update: (payload: unknown) => ((op.op = 'update'), (op.payload = payload), q),
      upsert: (payload: unknown, options?: unknown) => (
        (op.op = 'upsert'), (op.payload = payload), (op.options = options), q
      ),
      delete: () => ((op.op = 'delete'), q),
      eq: (column: string, value: unknown) => (op.filters.push(['eq', column, value]), q),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => {
        const fallback: Result = { data: op.op === 'select' ? [] : null, error: null }
        return Promise.resolve(responses[`${table}.${op.op}`] ?? fallback).then(resolve, reject)
      },
    }
    return q
  }

  function reset() {
    ops.length = 0
    for (const key of Object.keys(responses)) delete responses[key]
    for (const fn of Object.values(auth)) fn.mockReset()
    auth.getSession.mockResolvedValue({ data: { session: null } })
    auth.signOut.mockResolvedValue({ error: null })
  }

  return { ops, responses, auth, from, reset }
})

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: fake.auth, from: fake.from })),
}))

const user: User = { id: 'u1', email: 'a@b.com', name: 'A' }

/** The module reads its env at import time, so each test gets a fresh copy. */
async function loadBackend(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', env.VITE_SUPABASE_URL ?? 'https://x.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', env.VITE_SUPABASE_ANON_KEY ?? 'anon')
  vi.stubEnv('VITE_BACKEND', env.VITE_BACKEND ?? '')
  return import('../backend/supabase')
}

beforeEach(() => fake.reset())
afterEach(() => vi.unstubAllEnvs())

describe('mode selection', () => {
  it('is cloud when both Supabase keys are present', async () => {
    const { cloudConfigured, supabaseBackend } = await loadBackend()
    expect(cloudConfigured).toBe(true)
    expect(supabaseBackend.mode).toBe('cloud')
    const { backend } = await import('../backend')
    expect(backend.mode).toBe('cloud')
  })

  it('falls back to the device backend when a key is missing', async () => {
    await loadBackend({ VITE_SUPABASE_ANON_KEY: '' })
    const { backend } = await import('../backend')
    expect(backend.mode).toBe('device')
  })

  it('lets a self-hosted build win over Supabase keys', async () => {
    await loadBackend({ VITE_BACKEND: 'server' })
    const { backend } = await import('../backend')
    expect(backend.mode).toBe('server')
  })
})

describe('auth', () => {
  it('reports no user without a session', async () => {
    const { supabaseBackend } = await loadBackend()
    expect(await supabaseBackend.currentUser()).toBeNull()
  })

  it('maps the session user, falling back to the email for a name', async () => {
    const { supabaseBackend } = await loadBackend()
    fake.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u1', email: 'a@b.com', user_metadata: { name: 'Ann' } } } },
    })
    expect(await supabaseBackend.currentUser()).toEqual({ id: 'u1', email: 'a@b.com', name: 'Ann' })

    fake.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'u1', email: 'a@b.com', user_metadata: {} } } },
    })
    expect(await supabaseBackend.currentUser()).toEqual({ id: 'u1', email: 'a@b.com', name: 'a' })
  })

  it('signs up with a trimmed email and a name in the metadata', async () => {
    const { supabaseBackend } = await loadBackend()
    fake.auth.signUp.mockResolvedValue({
      data: { user: { id: 'u1', email: 'a@b.com' }, session: {} },
      error: null,
    })
    const u = await supabaseBackend.signUp('  a@b.com ', 'pw', 'Ann')
    expect(u).toEqual({ id: 'u1', email: 'a@b.com', name: 'Ann' })
    expect(fake.auth.signUp).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'pw',
      options: { data: { name: 'Ann' } },
    })
  })

  it('turns a sign-up without a session into a confirm-your-email error', async () => {
    const { supabaseBackend } = await loadBackend()
    const { AuthError } = await import('../backend/types')
    fake.auth.signUp.mockResolvedValue({
      data: { user: { id: 'u1', email: 'a@b.com' }, session: null },
      error: null,
    })
    await expect(supabaseBackend.signUp('a@b.com', 'pw', 'Ann')).rejects.toThrow(AuthError)
    await expect(supabaseBackend.signUp('a@b.com', 'pw', 'Ann')).rejects.toThrow(/confirm your email/i)
  })

  it('surfaces sign-in failures as AuthError', async () => {
    const { supabaseBackend } = await loadBackend()
    const { AuthError } = await import('../backend/types')
    fake.auth.signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Invalid login' } })
    await expect(supabaseBackend.signIn('a@b.com', 'nope')).rejects.toThrow(AuthError)
    await expect(supabaseBackend.signIn('a@b.com', 'nope')).rejects.toThrow('Invalid login')
  })
})

describe('load', () => {
  it('maps snake_case rows to the app shape and keys entries by habit and day', async () => {
    const { supabaseBackend } = await loadBackend()
    fake.responses['habits.select'] = {
      data: [
        {
          id: 'h1',
          name: 'Read',
          icon: '📚',
          color: 'blue',
          target: 1,
          unit: 'times',
          time_of_day: 'evening',
          area_id: null,
          days: [1, 2, 3],
          reminder: '21:00',
          github: 'octocat',
          archived: false,
          position: 0,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      error: null,
    }
    fake.responses['entries.select'] = {
      data: [{ habit_id: 'h1', date: '2026-01-02', value: 1, skipped: false, note: null }],
      error: null,
    }

    const data = await supabaseBackend.load(user)
    expect(data.habits).toEqual([
      {
        id: 'h1',
        name: 'Read',
        icon: '📚',
        color: 'blue',
        target: 1,
        unit: 'times',
        timeOfDay: 'evening',
        areaId: null,
        days: [1, 2, 3],
        reminder: '21:00',
        github: 'octocat',
        archived: false,
        position: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    const key = entryKey('h1', '2026-01-02')
    expect(data.entries[key]).toEqual({
      id: key,
      habitId: 'h1',
      date: '2026-01-02',
      value: 1,
      skipped: false,
      note: '',
    })
  })

  it('fails with context when a table cannot be read', async () => {
    const { supabaseBackend } = await loadBackend()
    fake.responses['entries.select'] = { data: null, error: { message: 'permission denied' } }
    await expect(supabaseBackend.load(user)).rejects.toThrow('Could not load check-ins: permission denied')
  })
})

describe('habits', () => {
  it('creates a habit under the user with snake_case columns', async () => {
    const { supabaseBackend } = await loadBackend()
    fake.responses['habits.insert'] = {
      data: {
        id: 'h1',
        name: 'Read',
        icon: '📚',
        color: 'blue',
        target: 1,
        unit: 'times',
        time_of_day: 'evening',
        area_id: null,
        days: [1],
        reminder: null,
        github: null,
        archived: false,
        position: 3,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    }
    const habit = await supabaseBackend.createHabit(
      user,
      {
        name: 'Read',
        icon: '📚',
        color: 'blue',
        target: 1,
        unit: 'times',
        timeOfDay: 'evening',
        areaId: null,
        days: [1],
        reminder: null,
        github: null,
      },
      3,
    )
    expect(fake.ops[0].payload).toEqual({
      name: 'Read',
      icon: '📚',
      color: 'blue',
      target: 1,
      unit: 'times',
      time_of_day: 'evening',
      area_id: null,
      days: [1],
      reminder: null,
      github: null,
      position: 3,
      user_id: 'u1',
    })
    expect(habit.timeOfDay).toBe('evening')
    expect(habit.position).toBe(3)
  })

  it('sends only the columns a patch changes', async () => {
    const { supabaseBackend } = await loadBackend()
    await supabaseBackend.updateHabit(user, 'h1', { github: 'octocat', timeOfDay: 'morning' })
    expect(fake.ops[0]).toMatchObject({
      table: 'habits',
      op: 'update',
      payload: { github: 'octocat', time_of_day: 'morning' },
      filters: [['eq', 'id', 'h1']],
    })
    expect(Object.keys(fake.ops[0].payload as object)).toHaveLength(2)
  })

  it('reports a failed reorder instead of swallowing it', async () => {
    const { supabaseBackend } = await loadBackend()
    fake.responses['habits.update'] = { data: null, error: { message: 'row locked' } }
    await expect(
      supabaseBackend.reorderHabits(user, [
        { id: 'h1', position: 0 },
        { id: 'h2', position: 1 },
      ]),
    ).rejects.toThrow('Could not reorder the habits: row locked')
    expect(fake.ops.map((o) => o.payload)).toEqual([{ position: 0 }, { position: 1 }])
  })

  it('surfaces a failed delete with context', async () => {
    const { supabaseBackend } = await loadBackend()
    fake.responses['habits.delete'] = { data: null, error: { message: 'nope' } }
    await expect(supabaseBackend.deleteHabit(user, 'h1')).rejects.toThrow('Could not delete the habit: nope')
  })
})

describe('setEntry', () => {
  it('saving a note leaves the value and skip alone', async () => {
    const { supabaseBackend } = await loadBackend()
    await supabaseBackend.setEntry(user, 'h1', '2026-01-02', { note: 'felt good' })
    const op = fake.ops[0]
    expect(op).toMatchObject({ table: 'entries', op: 'upsert', options: { onConflict: 'habit_id,date' } })
    expect(op.payload).toEqual({ user_id: 'u1', habit_id: 'h1', date: '2026-01-02', note: 'felt good' })
  })

  it('ticking a habit off leaves the note alone', async () => {
    const { supabaseBackend } = await loadBackend()
    await supabaseBackend.setEntry(user, 'h1', '2026-01-02', { value: 1, skipped: false })
    expect(fake.ops[0].payload).toEqual({
      user_id: 'u1',
      habit_id: 'h1',
      date: '2026-01-02',
      value: 1,
      skipped: false,
    })
  })

  it('a value of 0 is still sent, so a tick can be undone', async () => {
    const { supabaseBackend } = await loadBackend()
    await supabaseBackend.setEntry(user, 'h1', '2026-01-02', { value: 0 })
    expect(fake.ops[0].payload).toMatchObject({ value: 0 })
  })

  it('surfaces a failed save with context', async () => {
    const { supabaseBackend } = await loadBackend()
    fake.responses['entries.upsert'] = { data: null, error: { message: 'check constraint' } }
    await expect(supabaseBackend.setEntry(user, 'h1', '2026-01-02', { value: 1 })).rejects.toThrow(
      'Could not save the check-in: check constraint',
    )
  })
})
