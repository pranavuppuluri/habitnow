import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AppData, Area, ColorKey, Habit, TimeOfDay } from '../lib/types'
import { entryKey } from '../lib/stats'
import { AuthError, type Backend } from './types'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const cloudConfigured = Boolean(url && anonKey)

let client: SupabaseClient | null = null
function db(): SupabaseClient {
  if (!client) client = createClient(url!, anonKey!)
  return client
}

interface HabitRow {
  id: string
  name: string
  icon: string
  color: string
  target: number
  unit: string
  time_of_day: string
  area_id: string | null
  days: number[]
  reminder: string | null
  github: string | null
  archived: boolean
  position: number
  created_at: string
}

interface EntryRow {
  habit_id: string
  date: string
  value: number
  skipped: boolean
  note: string | null
}

function toHabit(row: HabitRow): Habit {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color as ColorKey,
    target: row.target,
    unit: row.unit,
    timeOfDay: row.time_of_day as TimeOfDay,
    areaId: row.area_id,
    days: row.days,
    reminder: row.reminder,
    github: row.github,
    archived: row.archived,
    position: row.position,
    createdAt: row.created_at,
  }
}

/** Only the columns the caller actually changed, so a patch stays a patch. */
function toHabitRow(patch: Partial<Habit>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.name = patch.name
  if (patch.icon !== undefined) row.icon = patch.icon
  if (patch.color !== undefined) row.color = patch.color
  if (patch.target !== undefined) row.target = patch.target
  if (patch.unit !== undefined) row.unit = patch.unit
  if (patch.timeOfDay !== undefined) row.time_of_day = patch.timeOfDay
  if (patch.areaId !== undefined) row.area_id = patch.areaId
  if (patch.days !== undefined) row.days = patch.days
  if (patch.reminder !== undefined) row.reminder = patch.reminder
  if (patch.github !== undefined) row.github = patch.github
  if (patch.archived !== undefined) row.archived = patch.archived
  if (patch.position !== undefined) row.position = patch.position
  if (patch.createdAt !== undefined) row.created_at = patch.createdAt
  return row
}

function fail(message: string, error: { message: string } | null): never | void {
  if (error) throw new Error(`${message}: ${error.message}`)
}

export const supabaseBackend: Backend = {
  mode: 'cloud',

  async currentUser() {
    const { data } = await db().auth.getSession()
    const u = data.session?.user
    if (!u) return null
    return { id: u.id, email: u.email ?? '', name: (u.user_metadata?.name as string) || (u.email ?? '').split('@')[0] }
  },

  async signUp(email, password, name) {
    const { data, error } = await db().auth.signUp({
      email: email.trim(),
      password,
      options: { data: { name: name.trim() || email.split('@')[0] } },
    })
    if (error) throw new AuthError(error.message)
    if (!data.user) throw new AuthError('Check your inbox to confirm the address, then sign in.')
    if (!data.session) throw new AuthError('Account created. Confirm your email, then sign in.')
    return { id: data.user.id, email: data.user.email ?? '', name: name || email.split('@')[0] }
  },

  async signIn(email, password) {
    const { data, error } = await db().auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw new AuthError(error.message)
    const u = data.user!
    return { id: u.id, email: u.email ?? '', name: (u.user_metadata?.name as string) || (u.email ?? '').split('@')[0] }
  },

  async signOut() {
    await db().auth.signOut()
  },

  async load() {
    const [habits, areas, entries] = await Promise.all([
      db().from('habits').select('*').order('position'),
      db().from('areas').select('*').order('position'),
      db().from('entries').select('*'),
    ])
    fail('Could not load habits', habits.error)
    fail('Could not load areas', areas.error)
    fail('Could not load check-ins', entries.error)

    const data: AppData = {
      habits: (habits.data as HabitRow[]).map(toHabit),
      areas: (areas.data as Area[]) ?? [],
      entries: {},
    }
    for (const row of (entries.data as EntryRow[]) ?? []) {
      const key = entryKey(row.habit_id, row.date)
      data.entries[key] = {
        id: key,
        habitId: row.habit_id,
        date: row.date,
        value: row.value,
        skipped: row.skipped,
        note: row.note ?? '',
      }
    }
    return data
  },

  async createHabit(user, draft, position) {
    const { data, error } = await db()
      .from('habits')
      .insert({ ...toHabitRow(draft as Partial<Habit>), position, user_id: user.id })
      .select()
      .single()
    fail('Could not save the habit', error)
    return toHabit(data as HabitRow)
  },

  async updateHabit(_user, id, patch) {
    const { error } = await db().from('habits').update(toHabitRow(patch)).eq('id', id)
    fail('Could not update the habit', error)
  },

  async deleteHabit(_user, id) {
    const { error } = await db().from('habits').delete().eq('id', id)
    fail('Could not delete the habit', error)
  },

  async reorderHabits(_user, ordered) {
    const results = await Promise.all(
      ordered.map(({ id, position }) => db().from('habits').update({ position }).eq('id', id)),
    )
    for (const { error } of results) fail('Could not reorder the habits', error)
  },

  async createArea(user, name, position) {
    const { data, error } = await db()
      .from('areas')
      .insert({ name, position, user_id: user.id })
      .select()
      .single()
    fail('Could not save the area', error)
    return data as Area
  },

  async deleteArea(_user, id) {
    const { error } = await db().from('areas').delete().eq('id', id)
    fail('Could not delete the area', error)
  },

  async setEntry(user, habitId, date, patch) {
    // Send only the fields in the patch. On conflict the upsert then updates
    // just those columns, so a note keeps the day's value and a tick keeps the
    // note; a new row takes the schema's defaults for the rest.
    const row: Record<string, unknown> = { user_id: user.id, habit_id: habitId, date }
    if (patch.value !== undefined) row.value = patch.value
    if (patch.skipped !== undefined) row.skipped = patch.skipped
    if (patch.note !== undefined) row.note = patch.note
    const { error } = await db().from('entries').upsert(row, { onConflict: 'habit_id,date' })
    fail('Could not save the check-in', error)
  },
}
