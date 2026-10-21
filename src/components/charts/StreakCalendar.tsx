import { fromKey, monthName, todayKey, WEEKDAY_SHORT } from '../../lib/date'
import { dayState, monthGrid, type DayState } from '../../lib/stats'
import { colorVar, inkVar, type AppData, type Habit } from '../../lib/types'
import { Left, Right } from '../icons'
import { ChartHost, ChartTooltip, useTooltip } from './chartkit'

interface StreakCalendarProps {
  data: AppData
  habit: Habit
  year: number
  month: number
  onShift: (delta: number) => void
  onPick?: (date: string) => void
}

const CELL = 38
const GAP = 5
const COLS = 7
const HEAD = 16
const W = COLS * CELL + (COLS - 1) * GAP

/**
 * A month calendar where a streak is drawn as one continuous bar rather than a
 * row of separate squares.
 *
 * That is the whole point of the view: an unbroken run should look unbroken. A
 * run that carries past Saturday keeps a flat edge at the week boundary and
 * resumes flat on the next row, so the eye reads it as continuing rather than as
 * two separate stretches, and the only rounded ends in the month are where a
 * streak genuinely started and stopped.
 */
export function StreakCalendar({ data, habit, year, month, onShift, onPick }: StreakCalendarProps) {
  const cells = monthGrid(year, month)
  const weeks = Math.ceil(cells.length / COLS)
  const today = todayKey()
  const hue = colorVar(habit.color)
  const onHue = inkVar(habit.color)
  const { tip, show, hide } = useTooltip()

  const now = fromKey(today)
  const atCurrentMonth = year === now.getFullYear() && month === now.getMonth()
  const H = HEAD + weeks * CELL + (weeks - 1) * GAP

  const x = (col: number) => col * (CELL + GAP)
  const y = (row: number) => HEAD + row * (CELL + GAP)

  // Maximal stretches of finished days inside each week row. Runs are cut at the
  // row edge for drawing, and the cut ends are kept square so they read as
  // continuing into the next row.
  const runs: { row: number; from: number; to: number; openStart: boolean; openEnd: boolean }[] = []
  for (let row = 0; row < weeks; row++) {
    let col = 0
    while (col < COLS) {
      const index = row * COLS + col
      const day = cells[index]
      if (!day || dayState(data, habit, day) !== 'done') {
        col++
        continue
      }
      let end = col
      while (end + 1 < COLS) {
        const next = cells[row * COLS + end + 1]
        if (!next || dayState(data, habit, next) !== 'done') break
        end++
      }
      // Does the run continue across the week boundary?
      const before = cells[index - 1]
      const after = cells[row * COLS + end + 1]
      runs.push({
        row,
        from: col,
        to: end,
        openStart: col === 0 && Boolean(before) && dayState(data, habit, before!) === 'done',
        openEnd: end === COLS - 1 && Boolean(after) && dayState(data, habit, after!) === 'done',
      })
      col = end + 1
    }
  }

  const label: Record<DayState, string> = {
    done: 'done',
    partial: 'partly done',
    missed: 'missed',
    skipped: 'skipped',
    off: 'not scheduled',
    upcoming: 'still open',
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">
          {monthName(month)} {year}
        </span>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" onClick={() => onShift(-1)} aria-label="Previous month">
            <Left />
          </button>
          <button className="icon-btn" onClick={() => onShift(1)} disabled={atCurrentMonth} aria-label="Next month">
            <Right />
          </button>
        </div>
      </div>

      <ChartHost>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="cal-svg"
          role="img"
          aria-label={`${habit.name} in ${monthName(month)} ${year}`}
          onMouseLeave={hide}
        >
          {WEEKDAY_SHORT.map((d, col) => (
            <text key={col} x={x(col) + CELL / 2} y={10} className="cal-dow-text" textAnchor="middle">
              {d}
            </text>
          ))}

          {/* Every scheduled day gets a track, so gaps in a streak are visible
              as gaps rather than as nothing at all. */}
          {cells.map((day, i) => {
            if (!day) return null
            const state = dayState(data, habit, day)
            if (state === 'off') return null
            return (
              <rect
                key={`track-${day}`}
                x={x(i % COLS)}
                y={y(Math.floor(i / COLS))}
                width={CELL}
                height={CELL}
                rx={10}
                fill={state === 'missed' ? 'var(--miss)' : 'var(--surface-2)'}
                opacity={state === 'missed' ? 0.6 : 1}
              />
            )
          })}

          {/* Partial days sit under the runs: a part-filled cell, same hue. */}
          {cells.map((day, i) => {
            if (!day || dayState(data, habit, day) !== 'partial') return null
            return (
              <rect
                key={`partial-${day}`}
                x={x(i % COLS)}
                y={y(Math.floor(i / COLS))}
                width={CELL}
                height={CELL}
                rx={10}
                fill={`color-mix(in srgb, ${hue} 38%, var(--surface-2))`}
              />
            )
          })}

          {/* The streaks themselves. */}
          {runs.map((run) => {
            const left = x(run.from)
            const width = x(run.to) + CELL - left
            const r = 10
            // A run cut by the week edge keeps that side square.
            const path = roundedSides(left, y(run.row), width, CELL, r, !run.openStart, !run.openEnd)
            return <path key={`run-${run.row}-${run.from}`} d={path} fill={hue} />
          })}

          {/* Skipped days read as an outline: present, deliberately not counted. */}
          {cells.map((day, i) => {
            if (!day || dayState(data, habit, day) !== 'skipped') return null
            return (
              <rect
                key={`skip-${day}`}
                x={x(i % COLS) + 1}
                y={y(Math.floor(i / COLS)) + 1}
                width={CELL - 2}
                height={CELL - 2}
                rx={9}
                fill="none"
                stroke="var(--line-strong)"
                strokeWidth={2}
                strokeDasharray="3 3"
              />
            )
          })}

          {/* Day numbers, plus the hit target for hover and click. */}
          {cells.map((day, i) => {
            if (!day) return null
            const col = i % COLS
            const row = Math.floor(i / COLS)
            const state = dayState(data, habit, day)
            const onRun = state === 'done'
            const d = fromKey(day)
            return (
              <g key={`hit-${day}`}>
                <text
                  x={x(col) + CELL / 2}
                  y={y(row) + CELL / 2 + 4}
                  textAnchor="middle"
                  className="cal-num"
                  fill={onRun ? onHue : state === 'off' ? 'var(--ink-3)' : 'var(--ink-2)'}
                  opacity={state === 'off' ? 0.45 : 1}
                >
                  {d.getDate()}
                </text>
                {day === today && (
                  <rect
                    x={x(col) - 2}
                    y={y(row) - 2}
                    width={CELL + 4}
                    height={CELL + 4}
                    rx={12}
                    fill="none"
                    stroke="var(--ink)"
                    strokeWidth={2}
                  />
                )}
                <rect
                  x={x(col)}
                  y={y(row)}
                  width={CELL}
                  height={CELL}
                  fill="transparent"
                  style={{ cursor: onPick ? 'pointer' : 'default' }}
                  onMouseMove={(e) =>
                    show(
                      e,
                      <>
                        <strong>
                          {d.getDate()} {monthName(month)}
                        </strong>
                        <span>{label[state]}</span>
                      </>,
                    )
                  }
                  onClick={() => onPick?.(day)}
                >
                  <title>{`${d.getDate()} ${monthName(month)}: ${label[state]}`}</title>
                </rect>
              </g>
            )
          })}
        </svg>
        <ChartTooltip tip={tip} />
      </ChartHost>

      <div className="legend">
        <span>
          <i style={{ background: hue }} /> Streak
        </span>
        <span>
          <i style={{ background: `color-mix(in srgb, ${hue} 38%, var(--surface-2))` }} /> Partial
        </span>
        <span>
          <i style={{ background: 'var(--miss)' }} /> Missed
        </span>
        <span>
          <i style={{ border: '2px dashed var(--line-strong)', borderRadius: 3 }} /> Skipped
        </span>
      </div>
    </section>
  )
}

/**
 * A rectangle with rounded ends only where a run actually begins or ends. The
 * square sides are what make a streak read as carrying across a week boundary.
 */
export function roundedSides(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  roundLeft: boolean,
  roundRight: boolean,
): string {
  const rl = roundLeft ? Math.min(r, w / 2, h / 2) : 0
  const rr = roundRight ? Math.min(r, w / 2, h / 2) : 0
  return [
    `M ${x + rl} ${y}`,
    `H ${x + w - rr}`,
    rr ? `A ${rr} ${rr} 0 0 1 ${x + w} ${y + rr}` : '',
    `V ${y + h - rr}`,
    rr ? `A ${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h}` : '',
    `H ${x + rl}`,
    rl ? `A ${rl} ${rl} 0 0 1 ${x} ${y + h - rl}` : '',
    `V ${y + rl}`,
    rl ? `A ${rl} ${rl} 0 0 1 ${x + rl} ${y}` : '',
    'Z',
  ]
    .filter(Boolean)
    .join(' ')
}
