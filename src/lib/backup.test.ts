/**
 * Backups: a file exported here has to load back exactly, and a damaged or
 * foreign file has to be refused with a reason rather than half-imported.
 */

import { expect, test } from 'vitest'
import { BackupError, backupFilename, describeData, parseBackup, toBackup } from './backup'
import type { AppData } from './types'

const DATA: AppData = {
  habits: [
    {
      id: 'h1', name: 'Drink water', icon: '💧', color: 'blue', target: 8, unit: 'glasses',
      timeOfDay: 'anytime', areaId: 'a1', days: [1, 2, 3], reminder: '09:00', github: null,
      archived: false, position: 0, createdAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  areas: [{ id: 'a1', name: 'Health', position: 0 }],
  entries: {
    'h1:2026-10-12': { id: 'h1:2026-10-12', habitId: 'h1', date: '2026-10-12', value: 8, skipped: false, note: 'easy' },
    'h1:2026-10-11': { id: 'h1:2026-10-11', habitId: 'h1', date: '2026-10-11', value: 0, skipped: true, note: '' },
  },
}

const fileOf = (data: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ app: 'habitnow', version: 1, exportedAt: '2026-10-13T00:00:00.000Z', data, ...over })

test('an exported backup loads back exactly', () => {
  const text = JSON.stringify(toBackup(DATA, new Date('2026-10-13T08:00:00Z')))
  expect(parseBackup(text)).toEqual(DATA)
})

test('refuses files that are not HabitNow backups, saying why', () => {
  expect(() => parseBackup('not json')).toThrow(BackupError)
  expect(() => parseBackup('{"habits": []}')).toThrow('not a HabitNow backup')
  expect(() => parseBackup(fileOf(DATA, { version: 99 }))).toThrow('newer version')
  expect(() => parseBackup(fileOf({ habits: [{ name: 'no id' }] }))).toThrow('Habit 1')
})

test('fills in fields an older backup did not have', () => {
  const old = { habits: [{ id: 'h1', name: 'Read' }], entries: {} }
  const [habit] = parseBackup(fileOf(old)).habits
  expect(habit).toMatchObject({ target: 1, timeOfDay: 'anytime', days: [0, 1, 2, 3, 4, 5, 6], github: null, archived: false })
})

test('drops entries for missing habits and links to missing areas', () => {
  const messy = {
    habits: [{ ...DATA.habits[0], areaId: 'gone' }],
    areas: [],
    entries: {
      a: { habitId: 'h1', date: '2026-10-12', value: 2 },
      b: { habitId: 'deleted', date: '2026-10-12', value: 1 },
      c: { habitId: 'h1', date: 'yesterday', value: 1 },
    },
  }
  const data = parseBackup(fileOf(messy))
  expect(data.habits[0].areaId).toBeNull()
  expect(Object.keys(data.entries)).toEqual(['h1:2026-10-12'])
})

test('names the file by day and describes what is in it', () => {
  expect(backupFilename('2026-10-13')).toBe('habitnow-backup-2026-10-13.json')
  expect(describeData(DATA)).toBe('1 habit, 1 area and 2 check-ins')
})
