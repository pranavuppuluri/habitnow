import type { AppData, Habit } from './types'
import { valueOn } from './stats'

/**
 * GitHub-tracked habits fill themselves in: each day's value is that day's
 * contribution count from the user's public profile calendar, so the streak
 * maths, calendar and charts treat it like any other counted habit.
 *
 * The counts come from github-contributions-api.jogruber.de, which reads the
 * public contribution calendar and allows cross-origin requests, so no token is
 * needed and it works from a static build. Private-repo work only appears if
 * "Include private contributions" is on in the GitHub profile settings.
 */

const API = 'https://github-contributions-api.jogruber.de/v4'

/** Date (YYYY-MM-DD) → number of contributions that day. */
export type Contributions = Record<string, number>

/** GitHub usernames: letters, digits and single hyphens, up to 39 characters. */
export function cleanUsername(input: string): string {
  return input.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '')
}

export function validUsername(name: string): boolean {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(name)
}

export async function fetchContributions(username: string): Promise<Contributions> {
  let res: Response
  try {
    res = await fetch(`${API}/${encodeURIComponent(username)}?y=last`)
  } catch {
    throw new Error('Could not reach GitHub. Check the connection and try again.')
  }
  if (res.status === 404) throw new Error(`No GitHub user called ${username}.`)
  if (!res.ok) throw new Error(`GitHub contributions are unavailable right now (${res.status}).`)
  const json = (await res.json()) as { contributions?: { date: string; count: number }[] }
  const out: Contributions = {}
  for (const day of json.contributions ?? []) out[day.date] = day.count
  return out
}

export interface GithubPlan {
  /** Days whose stored value differs from GitHub's count, up to and including today. */
  writes: { date: string; value: number }[]
  /**
   * The first day with a contribution, when it is earlier than the habit's
   * creation date. History before a habit existed is ignored by the streak
   * maths, and contributions made before the habit was added are real history.
   */
  backdateTo: string | null
}

/** What has to change for this habit's entries to match GitHub. Pure, so it is testable. */
export function planGithubSync(data: AppData, habit: Habit, counts: Contributions, today: string): GithubPlan {
  const writes: GithubPlan['writes'] = []
  let first: string | null = null
  for (const date of Object.keys(counts).sort()) {
    if (date > today) continue
    const count = counts[date]
    if (count > 0 && first === null) first = date
    if (valueOn(data, habit.id, date) !== count) writes.push({ date, value: count })
  }
  const created = habit.createdAt.slice(0, 10)
  return { writes, backdateTo: first !== null && first < created ? first : null }
}

/**
 * Turns daily counts into GitHub's five shades: 0 for an empty day, then 1-4
 * by quartile of the days that had any contributions. Scaling to the person's
 * own spread, rather than fixed cut-offs, is what makes a light year and a
 * busy year both read as a full range of shades.
 */
export function contributionLevels(counts: number[]): (count: number) => 0 | 1 | 2 | 3 | 4 {
  const active = counts.filter((c) => c > 0).sort((a, b) => a - b)
  if (active.length === 0) return () => 0
  const at = (q: number) => active[Math.min(active.length - 1, Math.floor(q * (active.length - 1)))]
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)]
  return (count) => (count <= 0 ? 0 : count <= q1 ? 1 : count <= q2 ? 2 : count <= q3 ? 3 : 4)
}
