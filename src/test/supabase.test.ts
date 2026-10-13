/**
 * Cloud mode: the real Supabase backend against an in-memory fake of the
 * client. The fake keeps rows per table, fills in the schema's column defaults,
 * and scopes every read and write to the signed-in user the way the row-level
 * security policies in supabase/schema.sql do.
 */
import { beforeEach, expect, test, vi } from 'vitest'

type Row = Record<string, unknown>

const fake = vi.hoisted(() => {
  const DEFAULTS: Record<string, Row> = {
    habits: {
      icon: '🎯', color: 'indigo', target: 1, unit: 'times', time_of_day: 'anytime', area_id: null,
      days: [0, 1, 2, 3, 4, 5, 6], reminder: null, github: null, archived: false, position: 0,
    },
    areas: { position: 0 },
    entries: { value: 0, skipped: false, note: '' },
  }

  const state = {
    tables: { habits: [] as Row[], areas: [] as Row[], entries: [] as Row[] } as Record<string, Row[]>,
    accounts: [] as { id: string; email: string; password: string; name: string }[],
    session: null as null | { user: { id: string; email: string; user_metadata: { name?: string } } },
    confirmEmail: false,
    failTable: null as string | null,
    /** Every payload sent to update or upsert, to check patches stay patches. */
    writes: [] as { table: string; op: string; payload: Row }[],
    seq: 0,
  }

  class Query {
    private op = 'select'
    private payload: Row = {}
    private filters: [string, unknown][] = []
    private conflict: string[] = []
    private orderBy: string | null = null
    private one = false
    constructor(private table: string) {}

    select() {
      return this
    }
    order(column: string) {
      this.orderBy = column
      return this
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value])
      return this
    }
    single() {
      this.one = true
      return this
    }
    insert(row: Row) {
      return this.write('insert', row)
    }
    update(patch: Row) {
      return this.write('update', patch)
    }
    upsert(row: Row, options: { onConflict: string }) {
      this.conflict = options.onConflict.split(',')
      return this.write('upsert', row)
    }
    delete() {
      this.op = 'delete'
      return this
    }
    private write(op: string, payload: Row) {
      this.op = op
      this.payload = payload
      state.writes.push({ table: this.table, op, payload })
      return this
    }

    then<T>(resolve: (r: { data: unknown; error: { message: string } | null }) => T) {
      return Promise.resolve(this.run()).then(resolve)
    }

    private run(): { data: unknown; error: { message: string } | null } {
      if (state.failTable === this.table) return { data: null, error: { message: 'connection reset' } }
      const uid = state.session?.user.id
      if (!uid) return { data: null, error: { message: 'JWT expired' } }
      const rows = state.tables[this.table]
      // Row-level security: a user only ever sees and touches their own rows.
      const visible = rows.filter((r) => r.user_id === uid && this.filters.every(([c, v]) => r[c] === v))

      if (this.op === 'select') {
        const out = [...visible]
        if (this.orderBy) out.sort((a, b) => Number(a[this.orderBy!]) - Number(b[this.orderBy!]))
        return { data: out, error: null }
      }
      if (this.op === 'insert') {
        if (this.payload.user_id !== uid) return { data: null, error: { message: 'violates row-level security' } }
        const row = { ...DEFAULTS[this.table], id: `id-${++state.seq}`, created_at: '2026-10-13T00:00:00.000Z', ...this.payload }
        rows.push(row)
        return { data: this.one ? row : [row], error: null }
      }
      if (this.op === 'update') {
        for (const r of visible) Object.assign(r, this.payload)
        return { data: null, error: null }
      }
      if (this.op === 'delete') {
        state.tables[this.table] = rows.filter((r) => !visible.includes(r))
        return { data: null, error: null }
      }
      // upsert: on conflict, PostgREST updates only the columns that were sent;
      // a fresh row gets the column defaults for the rest.
      const match = rows.find((r) => r.user_id === uid && this.conflict.every((c) => r[c] === this.payload[c]))
      if (match) Object.assign(match, this.payload)
      else rows.push({ ...DEFAULTS[this.table], id: `id-${++state.seq}`, ...this.payload })
      return { data: null, error: null }
    }
  }

  const client = {
    from: (table: string) => new Query(table),
    auth: {
      async getSession() {
        return { data: { session: state.session } }
      },
      async signUp({ email, password, options }: { email: string; password: string; options: { data: { name: string } } }) {
        if (state.accounts.some((a) => a.email === email)) return { data: {}, error: { message: 'User already registered' } }
        const account = { id: `user-${state.accounts.length + 1}`, email, password, name: options.data.name }
        state.accounts.push(account)
        const user = { id: account.id, email, user_metadata: { name: account.name } }
        if (!state.confirmEmail) state.session = { user }
        return { data: { user, session: state.confirmEmail ? null : state.session }, error: null }
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const a = state.accounts.find((x) => x.email === email && x.password === password)
        if (!a) return { data: {}, error: { message: 'Invalid login credentials' } }
        state.session = { user: { id: a.id, email, user_metadata: { name: a.name } } }
        return { data: { user: state.session.user }, error: null }
      },
      async signOut() {
        state.session = null
      },
    },
  }

  return { state, client }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fake.client }))

const { supabaseBackend: cloud } = await import('../backend/supabase')
const { AuthError } = await import('../backend/types')

const DRAFT = {
  name: 'Ship something', icon: '💻', color: 'green', target: 1, unit: 'contributions',
  timeOfDay: 'morning' as const, areaId: null, days: [1, 2, 3, 4, 5], reminder: '09:15', github: 'octocat',
}

beforeEach(() => {
  const s = fake.state
  s.tables = { habits: [], areas: [], entries: [] }
  s.accounts = []
  s.session = null
  s.confirmEmail = false
  s.failTable = null
  s.writes = []
})

test('sign up, sign out, sign in and the current user', async () => {
  expect(await cloud.currentUser()).toBeNull()
  const user = await cloud.signUp(' a@b.com ', 'secret', 'Asha')
  expect(user).toMatchObject({ email: 'a@b.com', name: 'Asha' })
  expect(await cloud.currentUser()).toEqual(user)

  await cloud.signOut()
  expect(await cloud.currentUser()).toBeNull()
  await expect(cloud.signIn('a@b.com', 'wrong')).rejects.toThrow(AuthError)
  expect(await cloud.signIn('a@b.com', 'secret')).toEqual(user)
  await expect(cloud.signUp('a@b.com', 'secret', 'Again')).rejects.toThrow('already registered')
})

test('with email confirmation on, sign-up says to check the inbox', async () => {
  fake.state.confirmEmail = true
  await expect(cloud.signUp('new@b.com', 'secret', '')).rejects.toThrow('Confirm your email')
})

test('a habit round-trips through the snake_case columns', async () => {
  const user = await cloud.signUp('a@b.com', 'secret', 'Asha')
  const created = await cloud.createHabit(user, DRAFT, 3)

  const row = fake.state.tables.habits[0]
  expect(row).toMatchObject({
    user_id: user.id, time_of_day: 'morning', area_id: null, github: 'octocat', reminder: '09:15', position: 3,
  })
  expect(row).not.toHaveProperty('timeOfDay')
  expect(created).toMatchObject({ ...DRAFT, position: 3, archived: false })

  const data = await cloud.load(user)
  expect(data.habits).toEqual([created])
})

test('an update sends only the columns that changed', async () => {
  const user = await cloud.signUp('a@b.com', 'secret', 'Asha')
  const habit = await cloud.createHabit(user, DRAFT, 0)
  await cloud.updateHabit(user, habit.id, { createdAt: '2026-01-02T00:00:00.000Z', archived: true })

  const sent = fake.state.writes.filter((w) => w.op === 'update').map((w) => w.payload)
  expect(sent).toEqual([{ created_at: '2026-01-02T00:00:00.000Z', archived: true }])
  expect((await cloud.load(user)).habits[0]).toMatchObject({ createdAt: '2026-01-02T00:00:00.000Z', archived: true })
})

test('a note does not wipe the check-in, and a tick does not wipe the note', async () => {
  const user = await cloud.signUp('a@b.com', 'secret', 'Asha')
  const habit = await cloud.createHabit(user, { ...DRAFT, target: 8, unit: 'glasses', github: null }, 0)

  await cloud.setEntry(user, habit.id, '2026-10-13', { value: 5, skipped: false })
  await cloud.setEntry(user, habit.id, '2026-10-13', { note: 'after lunch' })
  await cloud.setEntry(user, habit.id, '2026-10-13', { value: 6, skipped: false })

  const { entries } = await cloud.load(user)
  expect(entries[`${habit.id}:2026-10-13`]).toEqual({
    id: `${habit.id}:2026-10-13`, habitId: habit.id, date: '2026-10-13', value: 6, skipped: false, note: 'after lunch',
  })
  expect(fake.state.tables.entries).toHaveLength(1)
})

test('one account never sees another account\'s habits', async () => {
  const asha = await cloud.signUp('a@b.com', 'secret', 'Asha')
  await cloud.createHabit(asha, DRAFT, 0)
  await cloud.createArea(asha, 'Work', 0)
  await cloud.signOut()

  const ravi = await cloud.signUp('r@b.com', 'secret', 'Ravi')
  expect(await cloud.load(ravi)).toEqual({ habits: [], areas: [], entries: {} })
})

test('areas, ordering and deletes', async () => {
  const user = await cloud.signUp('a@b.com', 'secret', 'Asha')
  const a = await cloud.createHabit(user, { ...DRAFT, name: 'A' }, 0)
  const b = await cloud.createHabit(user, { ...DRAFT, name: 'B' }, 1)
  await cloud.reorderHabits(user, [{ id: a.id, position: 1 }, { id: b.id, position: 0 }])
  expect((await cloud.load(user)).habits.map((h) => h.name)).toEqual(['B', 'A'])

  const area = await cloud.createArea(user, 'Health', 0)
  expect((await cloud.load(user)).areas).toEqual([area])
  await cloud.deleteArea(user, area.id)
  await cloud.deleteHabit(user, a.id)
  const data = await cloud.load(user)
  expect(data.areas).toEqual([])
  expect(data.habits.map((h) => h.name)).toEqual(['B'])
})

test('a failed request says what failed instead of passing silently', async () => {
  const user = await cloud.signUp('a@b.com', 'secret', 'Asha')
  const habit = await cloud.createHabit(user, DRAFT, 0)
  fake.state.failTable = 'habits'
  await expect(cloud.load(user)).rejects.toThrow('Could not load habits: connection reset')
  await expect(cloud.updateHabit(user, habit.id, { name: 'x' })).rejects.toThrow('Could not update the habit')
  await expect(cloud.reorderHabits(user, [{ id: habit.id, position: 2 }])).rejects.toThrow('Could not reorder')
  fake.state.failTable = 'entries'
  await expect(cloud.setEntry(user, habit.id, '2026-10-13', { value: 1 })).rejects.toThrow('Could not save the check-in')
})

test('a build with Supabase keys runs in cloud mode, and a server build wins over it', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
  vi.resetModules()
  expect((await import('../backend')).backend.mode).toBe('cloud')

  vi.stubEnv('VITE_BACKEND', 'server')
  vi.resetModules()
  expect((await import('../backend')).backend.mode).toBe('server')

  vi.unstubAllEnvs()
  vi.resetModules()
  expect((await import('../backend')).backend.mode).toBe('device')
})
