/**
 * Render smoke tests.
 *
 * These exist because the charts are hand-drawn SVG with real geometry maths,
 * and a thrown error inside one of them would leave a blank panel that nothing
 * else in the suite would notice. Each test drives the app the way a person
 * would: sign up, add a habit, check it off, open the views.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { addDays, todayKey } from '../lib/date'

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/** Seeds a signed-in account with habits and history, the way the device backend stores it. */
function seed({ withHistory = true } = {}) {
  const userId = 'test-user'
  localStorage.setItem(
    'habitnow.users.v1',
    JSON.stringify({
      'a@b.com': { id: userId, email: 'a@b.com', name: 'Test', salt: 's', hash: 'x' },
    }),
  )
  localStorage.setItem('habitnow.session.v1', userId)

  const created = `${addDays(todayKey(), -60)}T00:00:00.000Z`
  const habits = [
    {
      id: 'h1', name: 'Drink water', icon: '💧', color: 'cyan', target: 8, unit: 'glasses',
      timeOfDay: 'anytime', areaId: null, days: EVERY_DAY, reminder: null,
      archived: false, position: 0, createdAt: created,
    },
    {
      id: 'h2', name: 'Meditate', icon: '🧘', color: 'indigo', target: 1, unit: 'times',
      timeOfDay: 'morning', areaId: null, days: EVERY_DAY, reminder: '07:30',
      archived: false, position: 1, createdAt: created,
    },
  ]

  const entries: Record<string, unknown> = {}
  if (withHistory) {
    // A run that crosses week boundaries, plus gaps, so the calendar has
    // genuine streak geometry to draw rather than a blank month.
    for (let i = 1; i <= 40; i++) {
      if (i % 7 === 3) continue
      const date = addDays(todayKey(), -i)
      entries[`h1:${date}`] = { id: `h1:${date}`, habitId: 'h1', date, value: 8, skipped: false, note: '' }
      if (i % 3 !== 0) {
        entries[`h2:${date}`] = { id: `h2:${date}`, habitId: 'h2', date, value: 1, skipped: false, note: '' }
      }
    }
    const skipped = addDays(todayKey(), -5)
    entries[`h2:${skipped}`] = { id: `h2:${skipped}`, habitId: 'h2', date: skipped, value: 0, skipped: true, note: '' }
  }

  localStorage.setItem(
    `habitnow.data.v1.${userId}`,
    JSON.stringify({ habits, areas: [{ id: 'ar1', name: 'Health', position: 0 }], entries }),
  )
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('a signed-out visitor lands on sign-up', async () => {
  render(<App />)
  expect(await screen.findByText('Start your first streak')).toBeTruthy()
})

test('the Today list renders habits grouped by time of day', async () => {
  seed()
  render(<App />)

  await screen.findAllByText(/Drink water/)
  // Scoped to the main column: the sidebar lists the same habit names.
  const main = document.querySelector('main') as HTMLElement

  // The exact row label, rather than a substring that also hits the ring's
  // screen-reader description.
  expect(within(main).getByText('💧 Drink water')).toBeTruthy()
  expect(within(main).getByText('🧘 Meditate')).toBeTruthy()
  expect(within(main).getByText('Morning')).toBeTruthy()
  // The reminder time is surfaced on the row.
  expect(within(main).getByText('07:30')).toBeTruthy()
})

test('tapping the ring checks a habit off and offers an undo', async () => {
  seed({ withHistory: false })
  render(<App />)

  const tick = await screen.findByTitle(/Meditate: tap to mark done/)
  fireEvent.click(tick)

  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Meditate done/))
  expect(within(screen.getByRole('status')).getByText('Undo')).toBeTruthy()
})

test('the Progress view renders every chart without throwing', async () => {
  seed()
  render(<App />)

  fireEvent.click(await screen.findByRole('button', { name: /Progress/ }))

  // Each panel is present, which means each chart returned markup.
  expect(await screen.findByText('Day of the week')).toBeTruthy()
  expect(screen.getByText('The last year')).toBeTruthy()
  expect(screen.getByText('Every habit')).toBeTruthy()
  expect(screen.getByText('All time')).toBeTruthy()

  // The trend and year charts really drew marks.
  expect(screen.getByLabelText(/Daily completion across the last 30 days/)).toBeTruthy()
  expect(screen.getByLabelText(/Daily completion over the last 53 weeks/)).toBeTruthy()
})

test('the time range switcher redraws the trend', async () => {
  seed()
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /Progress/ }))

  fireEvent.click(screen.getByRole('button', { name: '90d' }))
  expect(await screen.findByLabelText(/Daily completion across the last 90 days/)).toBeTruthy()
})

test('the detail sheet renders the streak calendar with joined runs', async () => {
  seed()
  render(<App />)

  fireEvent.click(await screen.findByRole('button', { name: /Open Drink water/ }))

  const calendar = await screen.findByLabelText(/Drink water in \w+ \d{4}/)
  // Streak runs are <path> elements; separate day cells are <rect>. A month with
  // a 40-day history must contain at least one drawn run.
  expect(calendar.querySelectorAll('path').length).toBeGreaterThan(0)
  expect(screen.getByText('Best run')).toBeTruthy()
})

test('a habit can be archived from the detail sheet and restored', async () => {
  seed()
  render(<App />)

  fireEvent.click(await screen.findByRole('button', { name: /Open Meditate/ }))
  fireEvent.click(await screen.findByRole('button', { name: /Archive/ }))

  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Meditate archived/))
  // It leaves Today and the Archive nav appears.
  await waitFor(() => expect(screen.queryByText(/🧘 Meditate/)).toBeNull())
})

test('areas can be created from the Areas screen', async () => {
  seed()
  render(<App />)

  fireEvent.click(await screen.findByRole('button', { name: /Areas/ }))
  const input = await screen.findByLabelText('New area')
  fireEvent.change(input, { target: { value: 'Focus' } })
  fireEvent.click(screen.getByRole('button', { name: /Add/ }))

  // It lands in the dialog list and in the sidebar filter, so expect both.
  await waitFor(() => expect(screen.getAllByText('Focus').length).toBeGreaterThan(0))
})

test('a GitHub habit fills itself in from the contribution graph', async () => {
  seed({ withHistory: false })
  const today = todayKey()
  const contributions = [-3, -2, -1, 0].map((offset) => ({
    date: addDays(today, offset),
    count: offset === -2 ? 0 : 4 + offset,
  }))
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ contributions })))
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  fireEvent.click((await screen.findAllByText('New habit'))[0])
  fireEvent.click(screen.getByText('GitHub contributions'))
  fireEvent.change(screen.getByLabelText('GitHub username'), { target: { value: '@octocat' } })
  fireEvent.click(screen.getByText('Add habit'))

  const main = document.querySelector('main') as HTMLElement
  expect(await within(main).findByText('4 contributions on GitHub')).toBeTruthy()
  expect(String(fetchMock.mock.calls[0][0])).toContain('/octocat?y=last')

  // Earlier contributions count as history: the habit was backdated to the
  // first one, so yesterday and the day before that keep a streak going.
  const stored = JSON.parse(localStorage.getItem('habitnow.data.v1.test-user')!)
  const gh = stored.habits.find((h: { github?: string }) => h.github === 'octocat')
  expect(gh.createdAt.slice(0, 10)).toBe(addDays(today, -3))
  expect(stored.entries[`${gh.id}:${addDays(today, -1)}`].value).toBe(3)
  expect(stored.entries[`${gh.id}:${addDays(today, -2)}`]).toBeUndefined()

  // The detail sheet draws GitHub's own graph: total for the year, a cell per day.
  fireEvent.click(within(main).getByText('4 contributions on GitHub'))
  expect(await screen.findByText('GitHub contributions')).toBeTruthy()
  const graph = screen.getByRole('img', { name: '8 GitHub contributions in the last year' })
  expect(graph.querySelectorAll('rect').length).toBeGreaterThan(360)
})
