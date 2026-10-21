/**
 * Backups are the only way device-mode data leaves a browser, so a bad import
 * is the one operation that could destroy everything at once. These tests pin
 * down what loads, what is refused, and what gets cleaned up on the way in.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { localBackend } from '../backend/local'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupError,
  backupFilename,
  describeData,
  makeBackup,
  parseBackup,
  serializeBackup,
} from './backup'
import type { AppData, Habit } from './types'

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: 'h1',
    name: 'Read',
    icon: '📚',
    color: 'blue',
    target: 10,
    unit: 'pages',
    timeOfDay: 'evening',
    areaId: 'ar1',
    days: [1, 3, 5],
    reminder: '21:00',
    github: null,
    archived: false,
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const sample: AppData = {
  habits: [habit(), habit({ id: 'h2', name: 'Commit', github: 'octocat', areaId: null, position: 1 })],
  areas: [{ id: 'ar1', name: 'Mind', position: 0 }],
  entries: {
    'h1:2026-01-02': { id: 'h1:2026-01-02', habitId: 'h1', date: '2026-01-02', value: 12, skipped: false, note: 'late' },
    'h2:2026-01-02': { id: 'h2:2026-01-02', habitId: 'h2', date: '2026-01-02', value: 0, skipped: true, note: '' },
  },
}

/** A backup with one field changed, as JSON text. */
function fileWith(patch: (b: Record<string, unknown>) => void, data: AppData = sample): string {
  const b = makeBackup(data) as unknown as Record<string, unknown>
  patch(b)
  return JSON.stringify(b)
}

describe('round trip', () => {
  it('reads back exactly what was written', () => {
    expect(parseBackup(serializeBackup(sample))).toEqual(sample)
  })

  it('stamps the file with the format, version and time', () => {
    const b = JSON.parse(serializeBackup(sample, new Date('2026-10-22T10:00:00Z')))
    expect(b.format).toBe(BACKUP_FORMAT)
    expect(b.version).toBe(BACKUP_VERSION)
    expect(b.exportedAt).toBe('2026-10-22T10:00:00.000Z')
  })

  it('names the file by the local date', () => {
    expect(backupFilename(new Date(2026, 9, 22, 23, 30))).toBe('habitnow-backup-2026-10-22.json')
  })

  it('describes a data set in plain words', () => {
    expect(describeData(sample)).toBe('2 habits, 1 area and 2 check-ins')
    expect(describeData({ habits: [habit()], areas: [], entries: {} })).toBe('1 habit, 0 areas and 0 check-ins')
  })
})

describe('refusals', () => {
  const refuses = (text: string, message: RegExp) => {
    expect(() => parseBackup(text)).toThrow(BackupError)
    expect(() => parseBackup(text)).toThrow(message)
  }

  it('refuses anything that is not JSON, or not an object', () => {
    refuses('not json', /not a HabitNow backup/)
    refuses('[1,2]', /not a HabitNow backup/)
    refuses('null', /not a HabitNow backup/)
  })

  it('refuses JSON from some other app', () => {
    refuses(JSON.stringify({ habits: sample.habits }), /not a HabitNow backup/)
    refuses(fileWith((b) => (b.format = 'other-app')), /not a HabitNow backup/)
    refuses(fileWith((b) => (b.version = 'one')), /not a HabitNow backup/)
  })

  it('refuses a file from a newer version of the app', () => {
    refuses(fileWith((b) => (b.version = BACKUP_VERSION + 1)), /newer version/)
  })

  it('refuses a file whose data is not the right shape', () => {
    refuses(fileWith((b) => delete b.data), /damaged/)
    refuses(fileWith((b) => ((b.data as Record<string, unknown>).habits = {})), /damaged/)
    refuses(fileWith((b) => ((b.data as Record<string, unknown>).entries = [])), /damaged/)
  })

  it('refuses habits, areas and check-ins missing what identifies them', () => {
    refuses(fileWith((b) => ((b.data as Record<string, unknown>).habits = [{ name: 'no id' }])), /damaged/)
    refuses(fileWith((b) => ((b.data as Record<string, unknown>).areas = [{ id: 'a' }])), /damaged/)
    refuses(
      fileWith((b) => ((b.data as Record<string, unknown>).entries = { x: { habitId: 'h1', date: 'yesterday' } })),
      /damaged/,
    )
  })

  it('refuses duplicate ids rather than guessing which wins', () => {
    refuses(serializeBackup({ ...sample, habits: [habit(), habit()] }), /damaged/)
  })
})

describe('older files', () => {
  it('fills in fields a smaller, older file left out', () => {
    const old = fileWith((b) => {
      b.version = 1
      b.data = {
        habits: [{ id: 'h1', name: 'Read', target: 10, unit: 'pages' }],
        areas: [],
        entries: { 'h1:2026-01-02': { habitId: 'h1', date: '2026-01-02', value: 12 } },
      }
    })
    const data = parseBackup(old)
    expect(data.habits[0]).toMatchObject({
      icon: '✅',
      color: 'blue',
      timeOfDay: 'anytime',
      areaId: null,
      days: EVERY_DAY,
      reminder: null,
      github: null,
      archived: false,
      position: 0,
    })
    expect(typeof data.habits[0].createdAt).toBe('string')
    expect(data.entries['h1:2026-01-02']).toEqual({
      id: 'h1:2026-01-02',
      habitId: 'h1',
      date: '2026-01-02',
      value: 12,
      skipped: false,
      note: '',
    })
  })

  it('normalises values that would break the stats', () => {
    const data = parseBackup(
      serializeBackup({
        ...sample,
        habits: [habit({ target: 0, days: [9, 3, 3, -1], timeOfDay: 'night' as never })],
      }),
    )
    expect(data.habits[0].target).toBe(1)
    expect(data.habits[0].days).toEqual([3])
    expect(data.habits[0].timeOfDay).toBe('anytime')
  })
})

describe('clean-up of broken links', () => {
  it('detaches a habit from an area that is not in the file', () => {
    const data = parseBackup(serializeBackup({ ...sample, areas: [] }))
    expect(data.habits.map((h) => h.areaId)).toEqual([null, null])
  })

  it('drops check-ins whose habit is not in the file', () => {
    const data = parseBackup(serializeBackup({ ...sample, habits: [habit()] }))
    expect(Object.keys(data.entries)).toEqual(['h1:2026-01-02'])
  })

  it('files a check-in under its proper key whatever key it arrived under', () => {
    const data = parseBackup(
      fileWith((b) => {
        ;(b.data as AppData).entries = {
          wrong: { id: 'wrong', habitId: 'h1', date: '2026-01-03', value: 1, skipped: false, note: '' },
        }
      }),
    )
    expect(Object.keys(data.entries)).toEqual(['h1:2026-01-03'])
    expect(data.entries['h1:2026-01-03'].id).toBe('h1:2026-01-03')
  })

  it('drops empty days, which the device backend never stores', () => {
    const data = parseBackup(
      fileWith((b) => {
        ;(b.data as AppData).entries = {
          'h1:2026-01-03': { id: 'h1:2026-01-03', habitId: 'h1', date: '2026-01-03', value: 0, skipped: false, note: '' },
        }
      }),
    )
    expect(data.entries).toEqual({})
  })
})

describe('restoring on a device', () => {
  const user = { id: 'u1', email: 'a@b.com', name: 'A' }

  beforeEach(() => localStorage.clear())

  it('replaces everything the device held with the backup', async () => {
    const existing = await localBackend.createHabit(user, habit(), 0)
    await localBackend.setEntry(user, existing.id, '2026-02-01', { value: 3 })

    await localBackend.replaceData!(user, parseBackup(serializeBackup(sample)))

    const after = await localBackend.load(user)
    expect(after).toEqual(sample)
    expect(after.habits.some((h) => h.id === existing.id)).toBe(false)
  })

  it('a refused file leaves the device untouched', async () => {
    await localBackend.createHabit(user, habit(), 0)
    const before = await localBackend.load(user)

    expect(() => parseBackup(fileWith((b) => (b.version = 99)))).toThrow(BackupError)

    expect(await localBackend.load(user)).toEqual(before)
  })
})
