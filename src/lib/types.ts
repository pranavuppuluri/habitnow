export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'anytime'

export const TIMES_OF_DAY: { key: TimeOfDay; label: string; hint: string }[] = [
  { key: 'morning', label: 'Morning', hint: 'Before noon' },
  { key: 'afternoon', label: 'Afternoon', hint: 'Noon to 6pm' },
  { key: 'evening', label: 'Evening', hint: 'After 6pm' },
  { key: 'anytime', label: 'Any time', hint: 'Whenever it fits' },
]

// The habit palette and its helpers live in ./colors, which carries the search
// and the validation results that decided it.
export {
  HABIT_COLORS,
  HABIT_INKS,
  COLOR_KEYS,
  COLOR_LABELS,
  colorKey,
  colorVar,
  inkVar,
  nextColor,
} from './colors'
export type { ColorKey } from './colors'

export interface Habit {
  id: string
  name: string
  icon: string
  /** A palette key; retired keys may still be present, so normalise with colorKey(). */
  color: string
  /** How many units count as a finished day. 1 for a plain yes/no habit. */
  target: number
  /** Plural noun for the unit, e.g. "times", "glasses", "pages". */
  unit: string
  timeOfDay: TimeOfDay
  areaId: string | null
  /** Weekdays the habit is scheduled on. 0 = Sunday. */
  days: number[]
  /** "HH:MM" local time, or null for no reminder. */
  reminder: string | null
  /** A GitHub username whose daily contributions fill this habit in, or null for a habit ticked by hand. */
  github?: string | null
  archived: boolean
  position: number
  createdAt: string
}

export interface Area {
  id: string
  name: string
  position: number
}

export interface Entry {
  /** `${habitId}:${date}` */
  id: string
  habitId: string
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  value: number
  skipped: boolean
  note: string
}

export interface HabitDraft {
  name: string
  icon: string
  /** A palette key; retired keys may still be present, so normalise with colorKey(). */
  color: string
  target: number
  unit: string
  timeOfDay: TimeOfDay
  areaId: string | null
  days: number[]
  reminder: string | null
  github?: string | null
}

export interface AppData {
  habits: Habit[]
  areas: Area[]
  entries: Record<string, Entry>
}

export interface User {
  id: string
  email: string
  name: string
}

export const EMPTY_DATA: AppData = { habits: [], areas: [], entries: {} }
