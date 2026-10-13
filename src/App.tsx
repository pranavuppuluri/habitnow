import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { backend } from './backend'
import { currentBucket, friendlyDate, todayKey } from './lib/date'
import { storageKey } from './lib/storage'
import { fetchContributions, planGithubSync, type Contributions } from './lib/github'
import { backupFilename, describeData, parseBackup, toBackup } from './lib/backup'
import { dayProgress, getEntry, habitsOn, valueOn } from './lib/stats'
import {
  EMPTY_DATA,
  colorVar,
  nextColor,
  TIMES_OF_DAY,
  type AppData,
  type Habit,
  type HabitDraft,
  type User,
} from './lib/types'
import { askForReminders, pendingCount, reminderPermission, scheduleReminders, type Permission } from './lib/reminders'
import { AreasSheet } from './components/AreasSheet'
import { Auth } from './components/Auth'
import { DateRail } from './components/DateRail'
import { HabitDetail } from './components/HabitDetail'
import { HabitForm } from './components/HabitForm'
import { HabitRow } from './components/HabitRow'
import { Progress } from './components/Progress'
import { Archive, Bell, Chart, Download, Exit, Folder, Logo, Moon, Plus, Sun, Today, Upload } from './components/icons'

type View = 'today' | 'progress' | 'archive'
type Theme = 'light' | 'dark'

const STARTERS = [
  { icon: '💧', name: 'Drink water', target: 8, unit: 'glasses', timeOfDay: 'anytime' as const },
  { icon: '🏃', name: 'Move for 30 minutes', target: 1, unit: 'times', timeOfDay: 'morning' as const },
  { icon: '📖', name: 'Read', target: 10, unit: 'pages', timeOfDay: 'evening' as const },
  { icon: '🧘', name: 'Meditate', target: 1, unit: 'times', timeOfDay: 'morning' as const },
  { icon: '😴', name: 'Lights out by 11', target: 1, unit: 'times', timeOfDay: 'evening' as const },
  { icon: '📵', name: 'No phone at dinner', target: 1, unit: 'times', timeOfDay: 'evening' as const },
]

function readTheme(): Theme {
  const saved = localStorage.getItem(storageKey('theme'))
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

interface Toast {
  message: string
  undo?: () => void
}

export default function App() {
  const [booting, setBooting] = useState(true)
  const [user, setUser] = useState<User | null>(null)
  const [data, setData] = useState<AppData>(EMPTY_DATA)
  const [view, setView] = useState<View>('today')
  const [date, setDate] = useState(todayKey())
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [toast, setToast] = useState<Toast | null>(null)

  const [formFor, setFormFor] = useState<{ habit: Habit | null; preset?: (typeof STARTERS)[number] } | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [areasOpen, setAreasOpen] = useState(false)
  const [areaFilter, setAreaFilter] = useState<string | null>(null)
  // Phones only: the bottom bar has room for the main views, the rest opens from here.
  const [menuOpen, setMenuOpen] = useState(false)
  const [notify, setNotify] = useState<Permission>(() => reminderPermission())
  // Which row is being dragged, and which row it is currently hovering over.
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(storageKey('theme'), theme)
  }, [theme])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  // Re-armed whenever habits or check-ins change, so finishing a habit cancels
  // its reminder and editing a time takes effect immediately.
  useEffect(() => {
    if (notify !== 'granted') return
    return scheduleReminders(data)
  }, [data, notify])

  const refresh = useCallback(async (u: User) => {
    try {
      setData(await backend.load(u))
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your habits.')
    }
  }, [])

  // Restore the session on first paint so a reload doesn't bounce to sign-in.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const existing = await backend.currentUser().catch(() => null)
      if (cancelled) return
      if (existing) {
        setUser(existing)
        await refresh(existing)
      }
      setBooting(false)
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  async function signedIn(u: User) {
    setUser(u)
    await refresh(u)
  }

  async function signOut() {
    await backend.signOut()
    setUser(null)
    setData(EMPTY_DATA)
    setView('today')
  }

  // The sync reads the latest data without re-running every time data changes.
  const dataRef = useRef(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])

  /**
   * Copies GitHub contribution counts into every GitHub-tracked habit. Only
   * days that differ are written, so a sync with nothing new costs one fetch
   * per username and no writes. `announce` is for the manual refresh, which
   * should say what happened; the background ones stay quiet.
   */
  const syncGithub = useCallback(
    async (u: User, announce = false) => {
      const tracked = dataRef.current.habits.filter((h) => !h.archived && h.github)
      if (tracked.length === 0) return
      try {
        const fetched = new Map<string, Promise<Contributions>>()
        let written = 0
        let today = 0
        for (const habit of tracked) {
          const name = habit.github!
          if (!fetched.has(name)) fetched.set(name, fetchContributions(name))
          const counts = await fetched.get(name)!
          today = Math.max(today, counts[todayKey()] ?? 0)
          const plan = planGithubSync(dataRef.current, habit, counts, todayKey())
          if (plan.backdateTo) {
            await backend.updateHabit(u, habit.id, { createdAt: `${plan.backdateTo}T00:00:00.000Z` })
          }
          for (const { date: day, value } of plan.writes) {
            await backend.setEntry(u, habit.id, day, { value })
          }
          written += plan.writes.length
        }
        await refresh(u)
        if (announce) {
          const counted = `${today} contribution${today === 1 ? '' : 's'} today`
          setToast({ message: written ? `GitHub synced. ${counted}.` : `Up to date with GitHub. ${counted}.` })
        }
      } catch (e) {
        if (announce) setToast({ message: e instanceof Error ? e.message : 'Could not sync with GitHub.' })
      }
    },
    [refresh],
  )

  // Sync when signed in, whenever the set of GitHub habits changes, when the
  // window comes back into focus, and every 15 minutes while it stays open.
  const githubKey = data.habits
    .filter((h) => !h.archived && h.github)
    .map((h) => `${h.id}:${h.github}`)
    .join(',')
  useEffect(() => {
    if (!user || !githubKey) return
    syncGithub(user)
    const onFocus = () => syncGithub(user)
    window.addEventListener('focus', onFocus)
    const timer = setInterval(() => syncGithub(user), 15 * 60 * 1000)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(timer)
    }
  }, [user, githubKey, syncGithub])

  const mutate = useCallback(
    async (job: (u: User) => Promise<void>) => {
      if (!user) return
      try {
        await job(user)
        await refresh(user)
      } catch (e) {
        setToast({ message: e instanceof Error ? e.message : 'That did not save.' })
      }
    },
    [user, refresh],
  )

  /** One tap: adds a unit, or clears the day once the target is met. */
  const tick = useCallback(
    (habit: Habit) => {
      // GitHub fills these in itself; a tap asks it for the latest instead.
      if (habit.github) {
        if (user) syncGithub(user, true)
        return
      }
      const before = valueOn(data, habit.id, date)
      const skipped = getEntry(data, habit.id, date)?.skipped ?? false
      const next = skipped ? 1 : before >= habit.target ? 0 : before + 1

      mutate((u) => backend.setEntry(u, habit.id, date, { value: next, skipped: false }))

      if (next >= habit.target && before < habit.target) {
        setToast({
          message: `${habit.name} done for ${friendlyDate(date).toLowerCase()}`,
          undo: () => {
            mutate((u) => backend.setEntry(u, habit.id, date, { value: before, skipped }))
            setToast(null)
          },
        })
      }
    },
    [data, date, mutate, user, syncGithub],
  )

  const active = useMemo(() => data.habits.filter((h) => !h.archived), [data.habits])
  const archived = useMemo(() => data.habits.filter((h) => h.archived), [data.habits])
  const scheduled = useMemo(
    () => habitsOn(data, date).filter((h) => areaFilter === null || h.areaId === areaFilter),
    [data, date, areaFilter],
  )
  const orderedActive = useMemo(() => [...active].sort((a, b) => a.position - b.position), [active])
  const progress = dayProgress(data, date)
  const detail = detailId ? data.habits.find((h) => h.id === detailId) ?? null : null
  const bucket = currentBucket()

  if (booting) {
    return <div className="booting">Loading…</div>
  }

  if (!user) {
    return <Auth onSignedIn={signedIn} />
  }

  async function saveHabit(draft: HabitDraft) {
    const editing = formFor?.habit
    if (editing) {
      await mutate((u) => backend.updateHabit(u, editing.id, draft))
    } else {
      const position = data.habits.length
      await mutate((u) => backend.createHabit(u, draft, position).then(() => undefined))
    }
    setFormFor(null)
  }

  async function addStarter(starter: (typeof STARTERS)[number]) {
    await mutate((u) =>
      backend
        .createHabit(
          u,
          {
            name: starter.name,
            icon: starter.icon,
            color: nextColor(data.habits.length),
            target: starter.target,
            unit: starter.unit,
            timeOfDay: starter.timeOfDay,
            areaId: null,
            days: [0, 1, 2, 3, 4, 5, 6],
            reminder: null,
          },
          data.habits.length,
        )
        .then(() => undefined),
    )
  }

  async function archiveHabit(habit: Habit) {
    setDetailId(null)
    await mutate((u) => backend.updateHabit(u, habit.id, { archived: true }))
    setToast({
      message: `${habit.name} archived`,
      undo: () => {
        mutate((u) => backend.updateHabit(u, habit.id, { archived: false }))
        setToast(null)
      },
    })
  }

  /**
   * Reorders the whole active list, then renumbers it 0..n-1. Positions are
   * global while the Today view renders them grouped by time of day, so working
   * on the flat list keeps both views consistent.
   */
  async function reorder(sourceId: string, targetId: string) {
    if (sourceId === targetId) return
    const ordered = [...active].sort((a, b) => a.position - b.position)
    const from = ordered.findIndex((h) => h.id === sourceId)
    const to = ordered.findIndex((h) => h.id === targetId)
    if (from < 0 || to < 0) return

    const [moved] = ordered.splice(from, 1)
    ordered.splice(to, 0, moved)
    await mutate((u) => backend.reorderHabits(u, ordered.map((h, i) => ({ id: h.id, position: i }))))
  }

  /** The keyboard route to reordering, from the detail sheet. */
  async function moveHabit(habit: Habit, delta: number) {
    const ordered = [...active].sort((a, b) => a.position - b.position)
    const index = ordered.findIndex((h) => h.id === habit.id)
    const target = ordered[index + delta]
    if (!target) return
    await reorder(habit.id, target.id)
  }

  async function enableReminders() {
    const result = await askForReminders()
    setNotify(result)
    if (result === 'granted') {
      const n = pendingCount(data)
      setToast({ message: n ? `Reminders on. ${n} still due today.` : 'Reminders on.' })
    } else if (result === 'denied') {
      setToast({ message: 'Your browser is blocking notifications for this site.' })
    }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(toBackup(data), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = backupFilename(todayKey())
    link.click()
    URL.revokeObjectURL(url)
    setToast({ message: `Backup saved: ${describeData(data)}.` })
  }

  async function importData(file: File) {
    const replace = backend.replaceData
    if (!replace) return
    let restored: AppData
    try {
      restored = parseBackup(await file.text())
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'That backup could not be read.' })
      return
    }
    const now = describeData(data)
    if (!confirm(`Replace ${now} on this device with ${describeData(restored)} from ${file.name}?`)) return
    await mutate((u) => replace(u, restored))
    setDetailId(null)
    setToast({ message: `Restored ${describeData(restored)}.` })
  }

  async function deleteHabit(habit: Habit) {
    if (!confirm(`Delete "${habit.name}" and all of its check-ins? This cannot be undone.`)) return
    setDetailId(null)
    await mutate((u) => backend.deleteHabit(u, habit.id))
    setToast({ message: `${habit.name} deleted` })
  }

  const initials = (user.name || user.email).slice(0, 1).toUpperCase()

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={24} />
          <span className="brand-name">HabitNow</span>
        </div>

        <button className="nav-item" aria-current={view === 'today'} onClick={() => setView('today')}>
          <Today /> Today
          <span className="count">
            {progress.done}/{progress.total}
          </span>
        </button>
        <button className="nav-item" aria-current={view === 'progress'} onClick={() => setView('progress')}>
          <Chart /> Progress
        </button>
        {archived.length > 0 && (
          <button className="nav-item" aria-current={view === 'archive'} onClick={() => setView('archive')}>
            <Archive /> Archive
            <span className="count">{archived.length}</span>
          </button>
        )}

        <button className="nav-item" onClick={() => setAreasOpen(true)}>
          <Folder /> Areas
          {data.areas.length > 0 && <span className="count">{data.areas.length}</span>}
        </button>

        <button
          className="nav-item nav-me"
          aria-expanded={menuOpen}
          aria-label="More"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="avatar">{initials}</span>
          More
        </button>

        {/* On a desktop this is just the rest of the sidebar; on a phone it is the "More" menu. */}
        <div className="nav-more" data-open={menuOpen} onClick={() => setMenuOpen(false)}>
          {data.areas.length > 0 && (
            <>
              <div className="nav-label">Filter by area</div>
              <button className="nav-item" aria-current={areaFilter === null} onClick={() => setAreaFilter(null)}>
                All habits
              </button>
              {data.areas.map((area) => (
                <button
                  key={area.id}
                  className="nav-item"
                  aria-current={areaFilter === area.id}
                  onClick={() => setAreaFilter(area.id)}
                >
                  {area.name}
                  <span className="count">{active.filter((h) => h.areaId === area.id).length}</span>
                </button>
              ))}
            </>
          )}

          {active.length > 0 && (
            <div className="nav-habits">
              <div className="nav-label">Habits</div>
              {active.map((habit) => (
                <button
                  key={habit.id}
                  className="nav-item"
                  onClick={() => {
                    setView('today')
                    setDetailId(habit.id)
                  }}
                >
                  <span className="nav-dot" style={{ background: colorVar(habit.color) }} />
                  {habit.name}
                </button>
              ))}
            </div>
          )}

          <div className="sidebar-foot">
            {notify !== 'unsupported' && notify !== 'granted' && (
              <button className="nav-item" onClick={enableReminders} disabled={notify === 'denied'}>
                <Bell /> {notify === 'denied' ? 'Reminders blocked' : 'Turn on reminders'}
              </button>
            )}
            <button className="nav-item" onClick={exportData} title="Save everything to a file you keep">
              <Download /> Export data
            </button>
            {backend.replaceData && (
              <label className="nav-item" title="Restore from a backup file">
                <Upload /> Import data
                <input
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file) void importData(file)
                  }}
                />
              </label>
            )}
            <button
              className="nav-item"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? <Sun /> : <Moon />} {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <button className="nav-item" onClick={signOut}>
              <Exit /> Sign out
            </button>
            <div className="who">
              <span className="avatar">{initials}</span>
              <span className="who-text">
                <span className="who-name">{user.name || user.email}</span>
                <span className="who-mode">{backend.mode === 'server' ? 'on server' : backend.mode === 'cloud' ? 'synced' : 'this device'}</span>
              </span>
            </div>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} />}

      <main className="main">
        <div className="main-inner">
          {loadError && <p className="alert">{loadError}</p>}

          {view === 'today' && (
            <>
              <header className="page-head">
                <div>
                  <h1>{friendlyDate(date)}</h1>
                  <p className="page-sub">
                    {progress.total === 0
                      ? 'Nothing scheduled for this day.'
                      : `${progress.done} of ${progress.total} finished.`}
                  </p>
                </div>
                <button className="btn btn-quiet" onClick={() => setFormFor({ habit: null })}>
                  <Plus size={16} /> New habit
                </button>
              </header>

              <DateRail data={data} selected={date} onSelect={setDate} />

              {active.length === 0 ? (
                <div className="empty">
                  <h2>Pick your first habit</h2>
                  <p>Start with one or two. Tap a suggestion to add it, or build your own.</p>
                  <div className="starter-grid">
                    {STARTERS.map((s) => (
                      <button key={s.name} className="starter" onClick={() => addStarter(s)}>
                        <span aria-hidden="true">{s.icon}</span> {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : scheduled.length === 0 ? (
                <div className="empty">
                  <h2>A clear day</h2>
                  <p>None of your habits are scheduled for this weekday. Enjoy it, or add one.</p>
                  <button className="btn btn-quiet" onClick={() => setFormFor({ habit: null })}>
                    <Plus size={16} /> New habit
                  </button>
                </div>
              ) : (
                <>
                  {progress.total > 0 && (
                    <div className="summary">
                      <span className="summary-figure">
                        {progress.done}
                        <small>/{progress.total}</small>
                      </span>
                      <span className="summary-text">
                        <span className="summary-label">
                          {progress.done === progress.total
                            ? 'Every habit checked off'
                            : progress.done === 0
                              ? 'Nothing checked off yet'
                              : `${progress.total - progress.done} to go`}
                        </span>
                        <br />
                        <span className="summary-hint">
                          {progress.done === progress.total
                            ? 'Come back tomorrow and keep the run going.'
                            : 'Tap a ring to check one off.'}
                        </span>
                      </span>
                    </div>
                  )}

                  {TIMES_OF_DAY.map((slot) => {
                    const inSlot = scheduled.filter((h) => h.timeOfDay === slot.key)
                    if (inSlot.length === 0) return null
                    const doneInSlot = inSlot.filter(
                      (h) =>
                        valueOn(data, h.id, date) >= h.target ||
                        getEntry(data, h.id, date)?.skipped,
                    ).length
                    return (
                      <section
                        className={slot.key === bucket ? 'group is-now' : 'group'}
                        key={slot.key}
                      >
                        <div className="group-head">
                          <span className="group-title">{slot.label}</span>
                          <span className="group-rule" />
                          <span className="group-count">
                            {doneInSlot}/{inSlot.length}
                          </span>
                        </div>
                        <div className="card-list">
                          {inSlot.map((habit) => (
                            <HabitRow
                              key={habit.id}
                              habit={habit}
                              data={data}
                              date={date}
                              onTick={() => tick(habit)}
                              onOpen={() => setDetailId(habit.id)}
                              drag={{
                                isDragging: dragId === habit.id,
                                isTarget: overId === habit.id && dragId !== habit.id,
                                onStart: () => setDragId(habit.id),
                                onOver: () => setOverId(habit.id),
                                onEnd: () => {
                                  setDragId(null)
                                  setOverId(null)
                                },
                                onDrop: () => {
                                  if (dragId) reorder(dragId, habit.id)
                                  setDragId(null)
                                  setOverId(null)
                                },
                              }}
                            />
                          ))}
                        </div>
                      </section>
                    )
                  })}
                </>
              )}
            </>
          )}

          {view === 'progress' && (
            <>
              <header className="page-head">
                <div>
                  <h1>Progress</h1>
                  <p className="page-sub">How every habit has held up so far.</p>
                </div>
              </header>
              <Progress data={data} onOpenHabit={(id) => setDetailId(id)} />
            </>
          )}

          {view === 'archive' && (
            <>
              <header className="page-head">
                <div>
                  <h1>Archive</h1>
                  <p className="page-sub">Paused habits keep their history. Restore one any time.</p>
                </div>
              </header>
              <div className="card-list">
                {archived.map((habit) => (
                  <article className="habit" key={habit.id}>
                    <span className="nav-dot" style={{ background: colorVar(habit.color), marginLeft: 12 }} />
                    <span className="habit-body">
                      <span className="habit-name">
                        {habit.icon} {habit.name}
                      </span>
                    </span>
                    <button
                      className="btn btn-quiet"
                      onClick={() => mutate((u) => backend.updateHabit(u, habit.id, { archived: false }))}
                    >
                      Restore
                    </button>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </main>

      <button className="fab" onClick={() => setFormFor({ habit: null })} aria-label="New habit">
        <Plus />
      </button>

      {formFor && (
        <HabitForm
          habit={formFor.habit}
          areas={data.areas}
          presetName={formFor.preset?.name}
          presetIcon={formFor.preset?.icon}
          onSave={saveHabit}
          onClose={() => setFormFor(null)}
        />
      )}

      {detail && (
        <HabitDetail
          habit={detail}
          data={data}
          date={date}
          onSetValue={(value) => mutate((u) => backend.setEntry(u, detail.id, date, { value, skipped: false }))}
          onSkip={() => {
            const skipped = getEntry(data, detail.id, date)?.skipped ?? false
            mutate((u) => backend.setEntry(u, detail.id, date, { skipped: !skipped, value: 0 }))
          }}
          onNote={(note) => mutate((u) => backend.setEntry(u, detail.id, date, { note }))}
          onEdit={() => {
            setDetailId(null)
            setFormFor({ habit: detail })
          }}
          onDelete={() => deleteHabit(detail)}
          onArchive={() => archiveHabit(detail)}
          onRefresh={() => syncGithub(user, true)}
          onMove={(delta) => moveHabit(detail, delta)}
          canMoveUp={orderedActive.findIndex((h) => h.id === detail.id) > 0}
          canMoveDown={
            orderedActive.findIndex((h) => h.id === detail.id) < orderedActive.length - 1
          }
          onClose={() => setDetailId(null)}
        />
      )}

      {areasOpen && (
        <AreasSheet
          areas={data.areas}
          habits={data.habits}
          onCreate={(name) =>
            mutate((u) => backend.createArea(u, name, data.areas.length).then(() => undefined))
          }
          onDelete={async (id) => {
            if (areaFilter === id) setAreaFilter(null)
            await mutate((u) => backend.deleteArea(u, id))
          }}
          onClose={() => setAreasOpen(false)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && <button onClick={toast.undo}>Undo</button>}
        </div>
      )}
    </div>
  )
}

