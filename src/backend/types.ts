import type { AppData, Area, Habit, HabitDraft, User } from '../lib/types'

export interface EntryPatch {
  value?: number
  skipped?: boolean
  note?: string
}

/** Push reminders, for a backend with a server that can send them. */
export interface PushApi {
  publicKey(): Promise<string>
  subscribe(subscription: PushSubscriptionJSON, timeZone: string): Promise<void>
  unsubscribe(endpoint: string): Promise<void>
  /** Sends a test notification to every subscribed browser; how many it reached. */
  test(): Promise<{ sent: number; devices: number }>
}

export interface Backend {
  /** 'server' for a self-hosted build, 'cloud' when Supabase keys are configured, otherwise 'device'. */
  mode: 'server' | 'cloud' | 'device'
  currentUser(): Promise<User | null>
  signUp(email: string, password: string, name: string): Promise<User>
  signIn(email: string, password: string): Promise<User>
  signOut(): Promise<void>

  load(user: User): Promise<AppData>
  createHabit(user: User, draft: HabitDraft, position: number): Promise<Habit>
  updateHabit(user: User, id: string, patch: Partial<Habit>): Promise<void>
  deleteHabit(user: User, id: string): Promise<void>
  reorderHabits(user: User, ordered: { id: string; position: number }[]): Promise<void>

  createArea(user: User, name: string, position: number): Promise<Area>
  deleteArea(user: User, id: string): Promise<void>

  setEntry(user: User, habitId: string, date: string, patch: EntryPatch): Promise<void>

  /** Present when reminders can be pushed with the app closed (the self-hosted server). */
  push?: PushApi
}

export class AuthError extends Error {}
