/**
 * Backups: one JSON file holding everything an account has.
 *
 * On GitHub Pages and unhuman.in the app runs in device mode, where habits and
 * check-ins live only in this browser's localStorage. Clearing site data or
 * changing phones loses them, and until now there was no way to get them out.
 * Export writes the file; import reads one back, strictly, and never touches
 * existing data unless the whole file passes.
 */
import { toKey } from './date'
import { entryKey } from './stats'
import { type AppData, type Area, type Entry, type Habit, type TimeOfDay } from './types'

export const BACKUP_FORMAT = 'habitnow-backup'

/**
 * Bump this when the data shape changes in a way an older app could not read.
 * Older files always load: anything they lack is filled in with a default.
 */
export const BACKUP_VERSION = 1

export interface Backup {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  data: AppData
}

/** A file that cannot be imported. The message is written for the person reading it. */
export class BackupError extends Error {}

const NOT_A_BACKUP = 'That file is not a HabitNow backup.'
const DAMAGED = 'That backup is damaged and cannot be read.'
const TOO_NEW = 'That backup was made by a newer version of HabitNow. Update the app, then try again.'

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const TIMES: TimeOfDay[] = ['morning', 'afternoon', 'evening', 'anytime']

export function makeBackup(data: AppData, now = new Date()): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    data: { habits: data.habits, areas: data.areas, entries: data.entries },
  }
}

export function serializeBackup(data: AppData, now = new Date()): string {
  return JSON.stringify(makeBackup(data, now), null, 2)
}

/** habitnow-backup-2026-10-22.json, dated in local time like everything else in the app. */
export function backupFilename(now = new Date()): string {
  return `habitnow-backup-${toKey(now)}.json`
}

/** "3 habits, 1 area and 120 check-ins", for the confirm before an import. */
export function describeData(data: AppData): string {
  const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
  return `${n(data.habits.length, 'habit')}, ${n(data.areas.length, 'area')} and ${n(
    Object.keys(data.entries).length,
    'check-in',
  )}`
}

/**
 * Reads a backup file. Throws BackupError, and nothing else, for anything it
 * will not load: files that are not HabitNow backups, files from a newer
 * version, and files whose habits, areas or check-ins are not what they claim.
 *
 * What comes back is clean: every habit's area exists or is null, every
 * check-in belongs to a habit in the file and sits under its proper key, and
 * fields a smaller, older file left out carry their defaults.
 */
export function parseBackup(text: string): AppData {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError(NOT_A_BACKUP)
  }
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) throw new BackupError(NOT_A_BACKUP)
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) throw new BackupError(NOT_A_BACKUP)
  if ((raw.version as number) > BACKUP_VERSION) throw new BackupError(TOO_NEW)

  const data = raw.data
  if (!isRecord(data) || !Array.isArray(data.habits) || !Array.isArray(data.areas) || !isRecord(data.entries)) {
    throw new BackupError(DAMAGED)
  }

  const areas = data.areas.map(readArea)
  const areaIds = new Set(areas.map((a) => a.id))
  if (areaIds.size !== areas.length) throw new BackupError(DAMAGED)

  const habits = data.habits.map((h, i) => readHabit(h, i, areaIds))
  const habitIds = new Set(habits.map((h) => h.id))
  if (habitIds.size !== habits.length) throw new BackupError(DAMAGED)

  const entries: Record<string, Entry> = {}
  for (const value of Object.values(data.entries)) {
    const entry = readEntry(value)
    // A check-in for a habit that is not in the file has nothing to attach to.
    if (!habitIds.has(entry.habitId)) continue
    // The device backend never stores an empty day; neither does an import.
    if (entry.value === 0 && !entry.skipped && entry.note === '') continue
    entries[entry.id] = entry
  }

  return { habits, areas, entries }
}

function readArea(raw: unknown): Area {
  if (!isRecord(raw) || !isId(raw.id) || typeof raw.name !== 'string') throw new BackupError(DAMAGED)
  return { id: raw.id, name: raw.name, position: numberOr(raw.position, 0) }
}

function readHabit(raw: unknown, index: number, areaIds: Set<string>): Habit {
  if (!isRecord(raw) || !isId(raw.id) || typeof raw.name !== 'string') throw new BackupError(DAMAGED)
  const areaId = typeof raw.areaId === 'string' && areaIds.has(raw.areaId) ? raw.areaId : null
  return {
    id: raw.id,
    name: raw.name,
    icon: typeof raw.icon === 'string' ? raw.icon : '✅',
    color: typeof raw.color === 'string' ? raw.color : 'blue',
    target: Math.max(1, Math.round(numberOr(raw.target, 1))),
    unit: typeof raw.unit === 'string' ? raw.unit : 'times',
    timeOfDay: TIMES.includes(raw.timeOfDay as TimeOfDay) ? (raw.timeOfDay as TimeOfDay) : 'anytime',
    areaId,
    days: readDays(raw.days),
    reminder: typeof raw.reminder === 'string' ? raw.reminder : null,
    github: typeof raw.github === 'string' ? raw.github : null,
    archived: raw.archived === true,
    position: numberOr(raw.position, index),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  }
}

function readDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return EVERY_DAY
  const days = [...new Set(raw.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
  return days.length ? days : EVERY_DAY
}

function readEntry(raw: unknown): Entry {
  if (!isRecord(raw) || !isId(raw.habitId) || !isDate(raw.date)) throw new BackupError(DAMAGED)
  return {
    id: entryKey(raw.habitId, raw.date),
    habitId: raw.habitId,
    date: raw.date,
    value: Math.max(0, numberOr(raw.value, 0)),
    skipped: raw.skipped === true,
    note: typeof raw.note === 'string' ? raw.note : '',
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Hands the browser a file to save. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Long enough for the download to start; the blob is freed afterwards.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
