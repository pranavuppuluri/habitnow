/**
 * Habit reminders.
 *
 * What this can and cannot do, stated plainly, because the UI has to say the
 * same thing:
 *
 * These are LOCAL notifications, scheduled by the open page. They fire while
 * HabitNow is open in a tab or as an installed app - including when that window
 * is in the background. They do NOT fire when the app is fully closed.
 *
 * Firing when the app is closed needs a push message from a server: a service
 * worker can only show a notification when something wakes it, and nothing on a
 * static host does that on a schedule. The Notification Triggers API, which would
 * have allowed true offline scheduling, never shipped. The self-hosted server
 * does exactly that (see lib/push.ts); when it is pushing, these local ones are
 * switched off so nothing arrives twice.
 */

import { todayKey } from './date'
import { storageKey } from './storage'
import type { AppData, Habit } from './types'
import { isScheduled, valueOn } from './stats'

const FIRED_KEY = storageKey('reminders.fired.v1')

export type Permission = 'unsupported' | 'default' | 'granted' | 'denied'

export function reminderPermission(): Permission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission as Permission
}

export async function askForReminders(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return (await Notification.requestPermission()) as Permission
  } catch {
    return 'denied'
  }
}

/** Reminders already shown, so a re-render or reload doesn't repeat one. */
function firedToday(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_KEY) ?? '{}') as { date?: string; ids?: string[] }
    if (raw.date !== todayKey()) return new Set()
    return new Set(raw.ids ?? [])
  } catch {
    return new Set()
  }
}

function markFired(id: string): void {
  const ids = firedToday()
  ids.add(id)
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify({ date: todayKey(), ids: [...ids] }))
  } catch {
    // Quota or private mode: at worst a reminder repeats after a reload.
  }
}

function minutesNow(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function parseTime(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Habits due a reminder later today that are not finished yet. */
function pending(data: AppData): { habit: Habit; at: number }[] {
  const today = todayKey()
  const now = minutesNow()
  const already = firedToday()

  return data.habits
    .filter((h) => !h.archived && h.reminder && isScheduled(h, today))
    .map((h) => ({ habit: h, at: parseTime(h.reminder!) }))
    .filter((r): r is { habit: Habit; at: number } => r.at !== null)
    .filter(({ habit, at }) => at > now && !already.has(habit.id) && valueOn(data, habit.id, today) < habit.target)
    .sort((a, b) => a.at - b.at)
}

function show(habit: Habit): void {
  if (reminderPermission() !== 'granted') return
  try {
    new Notification(`${habit.icon} ${habit.name}`, {
      body: habit.target > 1 ? `Time for your ${habit.target} ${habit.unit}.` : 'Time to check this one off.',
      tag: `habitnow-${habit.id}`,
      icon: './icons/icon-192.png',
    })
    markFired(habit.id)
  } catch {
    // Some browsers refuse a constructed Notification outside a service worker.
  }
}

/**
 * Schedules every reminder still due today and returns a cancel function.
 * Re-run it whenever habits or check-ins change; it is cheap and idempotent.
 */
export function scheduleReminders(data: AppData): () => void {
  if (reminderPermission() !== 'granted') return () => {}

  const now = minutesNow()
  const timers = pending(data).map(({ habit, at }) =>
    // setTimeout is capped near 24 days, and (at - now) is under a day here.
    window.setTimeout(() => show(habit), (at - now) * 60_000 - new Date().getSeconds() * 1000),
  )

  return () => timers.forEach(window.clearTimeout)
}

/** How many reminders are still ahead today, for the settings copy. */
export function pendingCount(data: AppData): number {
  return pending(data).length
}
