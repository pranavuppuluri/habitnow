/**
 * GitHub-tracked habits: which days get written, and when the habit's start
 * date is pulled back to cover real history.
 */

import { expect, test } from 'vitest'
import { cleanUsername, contributionLevels, planGithubSync, validUsername } from './github'
import type { AppData, Habit } from './types'

const TODAY = '2026-10-12'

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: 'gh',
    name: 'Contribute on GitHub',
    icon: '💻',
    color: 'indigo',
    target: 1,
    unit: 'contributions',
    timeOfDay: 'anytime',
    areaId: null,
    days: [0, 1, 2, 3, 4, 5, 6],
    reminder: null,
    github: 'octocat',
    archived: false,
    position: 0,
    createdAt: '2026-10-10T09:00:00.000Z',
    ...over,
  }
}

function withValues(values: Record<string, number>): AppData {
  const entries: AppData['entries'] = {}
  for (const [date, value] of Object.entries(values)) {
    entries[`gh:${date}`] = { id: `gh:${date}`, habitId: 'gh', date, value, skipped: false, note: '' }
  }
  return { habits: [habit()], areas: [], entries }
}

test('writes only the days that differ from GitHub', () => {
  const data = withValues({ '2026-10-11': 2, '2026-10-12': 1 })
  const plan = planGithubSync(data, habit(), { '2026-10-10': 0, '2026-10-11': 2, '2026-10-12': 5 }, TODAY)
  expect(plan.writes).toEqual([{ date: '2026-10-12', value: 5 }])
})

test('clears a day GitHub no longer counts', () => {
  const data = withValues({ '2026-10-11': 3 })
  const plan = planGithubSync(data, habit(), { '2026-10-11': 0 }, TODAY)
  expect(plan.writes).toEqual([{ date: '2026-10-11', value: 0 }])
})

test('never writes days after today', () => {
  const plan = planGithubSync(withValues({}), habit(), { '2026-10-12': 1, '2026-10-13': 4 }, TODAY)
  expect(plan.writes.map((w) => w.date)).toEqual(['2026-10-12'])
})

test('backdates the habit to its first contribution, so past work counts', () => {
  const counts = { '2026-09-01': 0, '2026-09-02': 3, '2026-10-12': 1 }
  expect(planGithubSync(withValues({}), habit(), counts, TODAY).backdateTo).toBe('2026-09-02')
})

test('does not backdate when there is nothing earlier, or it is already early enough', () => {
  expect(planGithubSync(withValues({}), habit(), { '2026-10-12': 1 }, TODAY).backdateTo).toBeNull()
  const old = habit({ createdAt: '2026-01-01T00:00:00.000Z' })
  expect(planGithubSync(withValues({}), old, { '2026-09-02': 3 }, TODAY).backdateTo).toBeNull()
})

test('accepts a username, an @handle or a profile link', () => {
  expect(cleanUsername('  octocat ')).toBe('octocat')
  expect(cleanUsername('@octocat')).toBe('octocat')
  expect(cleanUsername('https://github.com/octocat/hello-world')).toBe('octocat')
  expect(validUsername('pranavuppuluri')).toBe(true)
  expect(validUsername('a-b-c')).toBe(true)
  expect(validUsername('-bad')).toBe(false)
  expect(validUsername('two--hyphens')).toBe(false)
  expect(validUsername('')).toBe(false)
})

test('shades days by quartile of the active days, like GitHub', () => {
  // Active days 1,2,3,4,8,20 give quartile cut-offs of 2, 3 and 4.
  const level = contributionLevels([0, 0, 1, 2, 3, 4, 8, 20])
  expect([0, 1, 2, 3, 4, 8, 20].map(level)).toEqual([0, 1, 1, 2, 3, 4, 4])
  // Every active day the same: all of them take the first shade, as on GitHub.
  expect(contributionLevels([0, 5, 5])(5)).toBe(1)
  expect(contributionLevels([0, 0])(3)).toBe(0)
})
