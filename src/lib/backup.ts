import { entryKey } from './stats'
import type { AppData, Area, Entry, Habit, TimeOfDay } from './types'

/**
 * Backups: everything an account has, as one JSON file the person keeps.
 *
 * Device-only accounts live in this browser's localStorage, so clearing site
 * data or switching browsers loses them. A backup file is the way out: export
 * here, import there. Import is strict about shape but forgiving about age, so
 * a file from an older version still loads and fills in fields added since.
 */

export const BACKUP_APP = 'habitnow'
export const BACKUP_VERSION = 1

export interface Backup {
  app: typeof BACKUP_APP
  version: number
  exportedAt: string
  data: AppData
}

export function toBackup(data: AppData, now = new Date()): Backup {
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), data }
}

/** `habitnow-backup-2026-10-13.json`, dated by the local calendar day. */
export function backupFilename(today: string): string {
  return `habitnow-backup-${today}.json`
}

export class BackupError extends Error {}

const TIMES: TimeOfDay[] = ['morning', 'afternoon', 'evening', 'anytime']
const DATE = /^\d{4}-\d{2}-\d{2}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function readHabit(raw: unknown, index: number): Habit {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    throw new BackupError(`Habit ${index + 1} is missing its id or name.`)
  }
  const days = Array.isArray(raw.days) ? raw.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : []
  return {
    id: raw.id,
    name: raw.name,
    icon: str(raw.icon, '🎯'),
    color: str(raw.color, 'indigo'),
    target: Math.max(1, num(raw.target, 1)),
    unit: str(raw.unit, 'times'),
    timeOfDay: TIMES.includes(raw.timeOfDay as TimeOfDay) ? (raw.timeOfDay as TimeOfDay) : 'anytime',
    areaId: typeof raw.areaId === 'string' ? raw.areaId : null,
    days: days.length > 0 ? days : [0, 1, 2, 3, 4, 5, 6],
    reminder: typeof raw.reminder === 'string' ? raw.reminder : null,
    github: typeof raw.github === 'string' ? raw.github : null,
    archived: raw.archived === true,
    position: num(raw.position, index),
    createdAt: str(raw.createdAt, new Date().toISOString()),
  }
}

function readArea(raw: unknown, index: number): Area {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    throw new BackupError(`Area ${index + 1} is missing its id or name.`)
  }
  return { id: raw.id, name: raw.name, position: num(raw.position, index) }
}

/**
 * Parses a backup file's text into AppData, or throws a BackupError saying what
 * is wrong. Entries for habits that are not in the file are dropped, and every
 * entry is re-keyed, so the result is always internally consistent.
 */
export function parseBackup(text: string): AppData {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new BackupError('That file is not a HabitNow backup (it is not valid JSON).')
  }
  if (!isObject(json) || json.app !== BACKUP_APP || !isObject(json.data)) {
    throw new BackupError('That file is not a HabitNow backup.')
  }
  if (typeof json.version !== 'number' || json.version > BACKUP_VERSION) {
    throw new BackupError('That backup was made by a newer version of HabitNow. Reload the app and try again.')
  }

  const { data } = json
  const habits = (Array.isArray(data.habits) ? data.habits : []).map(readHabit)
  const areas = (Array.isArray(data.areas) ? data.areas : []).map(readArea)

  const habitIds = new Set(habits.map((h) => h.id))
  const areaIds = new Set(areas.map((a) => a.id))
  for (const habit of habits) if (habit.areaId && !areaIds.has(habit.areaId)) habit.areaId = null

  const entries: Record<string, Entry> = {}
  for (const raw of Object.values(isObject(data.entries) ? data.entries : {})) {
    if (!isObject(raw) || typeof raw.habitId !== 'string' || !habitIds.has(raw.habitId)) continue
    if (typeof raw.date !== 'string' || !DATE.test(raw.date)) continue
    const id = entryKey(raw.habitId, raw.date)
    entries[id] = {
      id,
      habitId: raw.habitId,
      date: raw.date,
      value: Math.max(0, num(raw.value, 0)),
      skipped: raw.skipped === true,
      note: str(raw.note),
    }
  }

  return { habits, areas, entries }
}

/** "3 habits, 1 area and 214 check-ins", for the confirm prompt and the toast. */
export function describeData(data: AppData): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const checkIns = Object.values(data.entries).filter((e) => e.value > 0 || e.skipped).length
  return `${n(data.habits.length, 'habit', 'habits')}, ${n(data.areas.length, 'area', 'areas')} and ${n(checkIns, 'check-in', 'check-ins')}`
}
