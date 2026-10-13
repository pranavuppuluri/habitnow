import { useEffect, useState } from 'react'
import { friendlyDate, fromKey } from '../lib/date'
import { getEntry, habitStats } from '../lib/stats'
import { colorVar, type AppData, type Habit } from '../lib/types'
import { ContributionGraph } from './charts/ContributionGraph'
import { StreakCalendar } from './charts/StreakCalendar'
import { YearHeat } from './charts/YearHeat'
import { Sheet } from './Sheet'
import { Archive, Left, Pencil, Right, Trash } from './icons'

interface HabitDetailProps {
  habit: Habit
  data: AppData
  date: string
  onSetValue: (value: number) => void
  onSkip: () => void
  onNote: (note: string) => void
  /** Pulls the latest counts for a GitHub-tracked habit. */
  onRefresh: () => void
  onEdit: () => void
  onDelete: () => void
  onArchive: () => void
  /** Shifts the habit's place in the list. -1 is earlier, 1 is later. */
  onMove: (delta: number) => void
  canMoveUp: boolean
  canMoveDown: boolean
  onClose: () => void
}

export function HabitDetail({
  habit,
  data,
  date,
  onSetValue,
  onSkip,
  onNote,
  onRefresh,
  onEdit,
  onDelete,
  onArchive,
  onMove,
  canMoveUp,
  canMoveDown,
  onClose,
}: HabitDetailProps) {
  const entry = getEntry(data, habit.id, date)
  const value = entry?.value ?? 0
  const skipped = entry?.skipped ?? false
  const stats = habitStats(data, habit)
  const color = colorVar(habit.color)

  const [note, setNote] = useState(entry?.note ?? '')
  const [cursor, setCursor] = useState(() => {
    const d = fromKey(date)
    return { year: d.getFullYear(), month: d.getMonth() }
  })

  // The note field is free text; save it when focus leaves rather than per keystroke.
  useEffect(() => {
    setNote(entry?.note ?? '')
  }, [entry?.note, habit.id, date])

  function shiftMonth(delta: number) {
    setCursor(({ year, month }) => {
      const next = new Date(year, month + delta, 1)
      return { year: next.getFullYear(), month: next.getMonth() }
    })
  }

  return (
    <Sheet
      title={`${habit.icon} ${habit.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-danger" onClick={onDelete} aria-label="Delete">
            <Trash /> <span className="wide-only">Delete</span>
          </button>
          <button
            className="btn btn-quiet"
            onClick={onArchive}
            aria-label="Archive"
            title="Keep the history, hide it from Today"
          >
            <Archive /> <span className="wide-only">Archive</span>
          </button>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={onEdit}>
            <Pencil /> Edit
          </button>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">{friendlyDate(date)}</span>
        <div className="row">
          {habit.github ? (
            <div className="stepper">
              <span className="stepper-val">
                {value}
                <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                  {' '}
                  {habit.target > 1 && `/ ${habit.target} `}
                  {habit.unit}
                </span>
              </span>
              <button onClick={onRefresh} aria-label="Refresh from GitHub" title={`Refresh from github.com/${habit.github}`}>
                &#8635;
              </button>
            </div>
          ) : (
            <div className="stepper">
              <button onClick={() => onSetValue(Math.max(0, value - 1))} disabled={value === 0} aria-label="One fewer">
                &minus;
              </button>
              <span className="stepper-val">
                {value}
                <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                  {' '}
                  / {habit.target} {habit.unit}
                </span>
              </span>
              <button onClick={() => onSetValue(value + 1)} aria-label="One more">
                +
              </button>
            </div>
          )}
          <button
            className="btn btn-quiet"
            style={{ flex: '0 0 auto' }}
            onClick={onSkip}
            aria-pressed={skipped}
          >
            {skipped ? 'Un-skip day' : 'Skip day'}
          </button>
        </div>
        <p className="help">A skipped day keeps the streak alive without counting toward it.</p>
      </div>

      <div className="field">
        <span className="field-label">Place in the list</span>
        <div className="stepper" style={{ display: 'inline-flex' }}>
          <button onClick={() => onMove(-1)} disabled={!canMoveUp} aria-label="Move earlier">
            <Left />
          </button>
          <button onClick={() => onMove(1)} disabled={!canMoveDown} aria-label="Move later">
            <Right />
          </button>
        </div>
        <p className="help">Habits can also be dragged into order on the Today list.</p>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-key">Streak</div>
          <div className="stat-val" style={{ color }}>
            {stats.streak}
            <small> days</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-key">Best run</div>
          <div className="stat-val">
            {stats.best}
            <small> days</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-key">Finished</div>
          <div className="stat-val">
            {Math.round(stats.rate * 100)}
            <small>%</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-key">Total {habit.unit}</div>
          <div className="stat-val">{stats.total}</div>
        </div>
      </div>

      <StreakCalendar
        data={data}
        habit={habit}
        year={cursor.year}
        month={cursor.month}
        onShift={shiftMonth}
      />

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">{habit.github ? 'GitHub contributions' : 'The last year'}</span>
        </div>
        {habit.github ? (
          <ContributionGraph data={data} habit={habit} />
        ) : (
          <YearHeat data={data} habitId={habit.id} hue={color} weeks={40} />
        )}
      </section>

      <div className="field" style={{ marginTop: 18, marginBottom: 0 }}>
        <label htmlFor="habit-note">Note for {friendlyDate(date).toLowerCase()}</label>
        <textarea
          id="habit-note"
          className="note-area"
          value={note}
          placeholder="What made it easy or hard today?"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (entry?.note ?? '') && onNote(note)}
        />
      </div>
    </Sheet>
  )
}
