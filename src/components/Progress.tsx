import { useMemo, useState } from 'react'
import { dayRange, todayKey } from '../lib/date'
import { completionSeries, dayShare, habitStats, weekdayBreakdown } from '../lib/stats'
import { colorVar, type AppData, type Habit } from '../lib/types'
import { TrendChart } from './charts/TrendChart'
import { WeekdayBars } from './charts/WeekdayBars'
import { ContributionGraph } from './charts/ContributionGraph'
import { YearHeat } from './charts/YearHeat'

interface ProgressProps {
  data: AppData
  onOpenHabit: (id: string) => void
}

const PERIODS = [
  { key: 30, label: '30d' },
  { key: 90, label: '90d' },
  { key: 365, label: '1y' },
] as const

export function Progress({ data, onOpenHabit }: ProgressProps) {
  const [days, setDays] = useState<number>(30)
  const [focus, setFocus] = useState<string | null>(null)

  const active = useMemo(() => data.habits.filter((h) => !h.archived), [data.habits])
  const dates = useMemo(() => dayRange(todayKey(), days), [days])
  const focused = focus ? (active.find((h) => h.id === focus) ?? null) : null

  const series = useMemo(
    () => (focused ? dates.map((d) => dayShare(data, d, focused.id)) : completionSeries(data, dates)),
    [data, dates, focused],
  )
  const weekdays = useMemo(() => weekdayBreakdown(data, dates, focused?.id), [data, dates, focused])

  const rows = useMemo(
    () =>
      active
        .map((habit) => ({ habit, stats: habitStats(data, habit) }))
        .sort((a, b) => b.stats.streak - a.stats.streak),
    [active, data],
  )

  if (active.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing to chart yet</h2>
        <p>Add a habit and check it off for a few days. Your trend shows up here.</p>
      </div>
    )
  }

  const hue = focused ? colorVar(focused.color) : undefined
  const scope = focused ? `${focused.icon} ${focused.name}` : 'All habits'

  const totalDone = rows.reduce((n, r) => n + r.stats.doneDays, 0)
  const bestStreak = rows.reduce((n, r) => Math.max(n, r.stats.best), 0)
  const liveStreaks = rows.filter((r) => r.stats.streak > 0).length
  const avgRate = rows.reduce((n, r) => n + r.stats.rate, 0) / rows.length
  const windowRate = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0

  return (
    <>
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-key">Check-ins</div>
          <div className="stat-val">{totalDone}</div>
        </div>
        <div className="stat">
          <div className="stat-key">Live streaks</div>
          <div className="stat-val">
            {liveStreaks}
            <small> / {rows.length}</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-key">Best run</div>
          <div className="stat-val">
            {bestStreak}
            <small> days</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-key">Average rate</div>
          <div className="stat-val">
            {Math.round(avgRate * 100)}
            <small>%</small>
          </div>
        </div>
      </div>

      {/* One filter row, controlling every chart below it. */}
      <section className="panel">
        <div className="panel-head" style={{ flexWrap: 'wrap', rowGap: 8 }}>
          <span className="panel-title">{scope}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="Scope">
              <button aria-pressed={focus === null} onClick={() => setFocus(null)}>
                All
              </button>
              {active.slice(0, 6).map((h) => (
                <button key={h.id} aria-pressed={focus === h.id} onClick={() => setFocus(h.id)} title={h.name}>
                  <span aria-hidden="true">{h.icon}</span>
                  <span className="sr-only">{h.name}</span>
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Time range">
              {PERIODS.map((p) => (
                <button key={p.key} aria-pressed={days === p.key} onClick={() => setDays(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <TrendChart dates={dates} series={series} hue={hue} />
        <p className="help" style={{ marginTop: 10 }}>
          {Math.round(windowRate * 100)}% finished on average over the last {days} days. The line is a
          seven-day average.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Day of the week</span>
        </div>
        <WeekdayBars stats={weekdays} hue={hue} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">{focused?.github ? 'GitHub contributions' : 'The last year'}</span>
        </div>
        {focused?.github ? (
          <ContributionGraph data={data} habit={focused} />
        ) : (
          <YearHeat data={data} habitId={focused?.id} hue={hue} />
        )}
      </section>

      {/* Small multiples: hue identifies a habit safely here because each gets its
          own row and its own name, rather than competing inside one plot. */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Every habit</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            last {Math.min(days, 60)} days
          </span>
        </div>

        {rows.map(({ habit, stats }) => (
          <HabitSparkRow
            key={habit.id}
            habit={habit}
            data={data}
            days={Math.min(days, 60)}
            rate={stats.rate}
            streak={stats.streak}
            onOpen={() => onOpenHabit(habit.id)}
          />
        ))}
      </section>

      {/* The table is the accessible read of the same numbers. */}
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">All time</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Habit</th>
              <th>Streak</th>
              <th>Best</th>
              <th>Rate</th>
              <th>Days</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ habit, stats }) => (
              <tr key={habit.id}>
                <td>
                  <span className="name">
                    <span className="nav-dot" style={{ background: colorVar(habit.color) }} />
                    {habit.icon} {habit.name}
                  </span>
                </td>
                <td className="mono">{stats.streak}</td>
                <td className="mono">{stats.best}</td>
                <td className="mono">{Math.round(stats.rate * 100)}%</td>
                <td className="mono">
                  {stats.doneDays}/{stats.scheduledDays}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}

interface SparkRowProps {
  habit: Habit
  data: AppData
  days: number
  rate: number
  streak: number
  onOpen: () => void
}

function HabitSparkRow({ habit, data, days, rate, streak, onOpen }: SparkRowProps) {
  const dates = dayRange(todayKey(), days)
  const hue = colorVar(habit.color)

  return (
    <div className="sm-row">
      <div>
        <button className="sm-head sm-head-btn" onClick={onOpen}>
          <span className="nav-dot" style={{ background: hue }} />
          <span>
            {habit.icon} {habit.name}
          </span>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-3)' }}>
            {streak}d
          </span>
        </button>
        <div
          className="sm-spark"
          role="img"
          aria-label={`${habit.name}: ${Math.round(rate * 100)} percent finished over ${days} days`}
        >
          {dates.map((d) => {
            const share = dayShare(data, d, habit.id)
            return (
              <i
                key={d}
                title={`${d}: ${Math.round(share * 100)}%`}
                style={{
                  height: share > 0 ? `${Math.max(18 * share, 4)}px` : '2px',
                  background: share > 0 ? hue : 'var(--miss)',
                  opacity: share > 0 ? 0.35 + share * 0.65 : 1,
                }}
              />
            )
          })}
        </div>
      </div>
      <div className="sm-rate">
        {Math.round(rate * 100)}%<small>kept</small>
      </div>
    </div>
  )
}
