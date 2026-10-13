import { useLayoutEffect, useRef } from 'react'
import { addDays, fromKey, monthName, todayKey } from '../../lib/date'
import { contributionLevels } from '../../lib/github'
import { valueOn } from '../../lib/stats'
import { colorVar, type AppData, type Habit } from '../../lib/types'
import { ChartHost, ChartTooltip, ramp, useTooltip } from './chartkit'

interface ContributionGraphProps {
  data: AppData
  /** A GitHub-tracked habit; its synced entries are the daily counts. */
  habit: Habit
}

const WEEKS = 53
const CELL = 11
const GAP = 3
const HEAD = 16
const SIDE = 30
const DAY_LABELS: Record<number, string> = { 1: 'Mon', 3: 'Wed', 5: 'Fri' }
const LONG_DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The GitHub profile contribution graph, redrawn from the synced entries:
 * 53 Sunday-first week columns ending today, month labels on top, Mon/Wed/Fri
 * down the side, and five shades set by quartile like GitHub's own.
 *
 * Shades are a ramp in the habit's hue, as every one-habit chart here is; a
 * habit coloured green looks like the one on github.com.
 */
export function ContributionGraph({ data, habit }: ContributionGraphProps) {
  const { tip, show, hide } = useTooltip()
  const scroller = useRef<HTMLDivElement>(null)

  // Too wide for a narrow panel: open at the newest weeks, as GitHub does.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])
  const hue = colorVar(habit.color)
  const today = todayKey()

  const lastColumnStart = addDays(today, -fromKey(today).getDay())
  const firstDay = addDays(lastColumnStart, -(WEEKS - 1) * 7)
  const columns = Array.from({ length: WEEKS }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(firstDay, w * 7 + d)),
  )

  // "The last year" on GitHub runs from a year ago today, not from the first
  // column, so the total and the shading use the same window it does.
  const yearAgo = addDays(today, -365)
  const counts = new Map<string, number>()
  for (const day of columns.flat()) {
    if (day > today) continue
    counts.set(day, valueOn(data, habit.id, day))
  }
  const inYear = [...counts].filter(([day]) => day > yearAgo).map(([, c]) => c)
  const total = inYear.reduce((a, b) => a + b, 0)
  const level = contributionLevels(inYear)

  const labels: { x: number; text: string }[] = []
  let lastMonth = -1
  columns.forEach((col, w) => {
    const m = fromKey(col[0]).getMonth()
    if (m !== lastMonth) {
      lastMonth = m
      labels.push({ x: w * (CELL + GAP), text: monthName(m) })
    }
  })

  const W = WEEKS * CELL + (WEEKS - 1) * GAP
  const H = HEAD + 7 * CELL + 6 * GAP
  const unit = (n: number) => (n === 1 ? 'contribution' : 'contributions')

  return (
    <ChartHost>
      <div className="gh-head">
        <span>
          <strong className="mono">{total.toLocaleString()}</strong> {unit(total)} in the last year
        </span>
        {habit.github && (
          <a href={`https://github.com/${habit.github}`} target="_blank" rel="noreferrer" className="gh-link">
            @{habit.github}
          </a>
        )}
      </div>

      <div className="gh-body">
        {/* Weekday labels sit outside the scroller so they stay put, like GitHub's. */}
        <svg width={SIDE} height={H} aria-hidden="true" className="gh-days">
          {Object.entries(DAY_LABELS).map(([d, text]) => (
            <text key={d} x={0} y={HEAD + Number(d) * (CELL + GAP) + CELL - 2} className="cal-dow-text">
              {text}
            </text>
          ))}
        </svg>
        <div className="year-scroll" ref={scroller}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            role="img"
            aria-label={`${total} GitHub contributions in the last year`}
            onMouseLeave={hide}
          >
            {labels.map((l, i) =>
              // Drop a label that would collide with the one before it.
              i > 0 && l.x - labels[i - 1].x < 26 ? null : (
                <text key={`${l.text}-${l.x}`} x={l.x} y={10} className="cal-dow-text">
                  {l.text}
                </text>
              ),
            )}

            {columns.map((col, w) =>
              col.map((day, d) => {
                if (day > today) return null
                const count = counts.get(day) ?? 0
                const date = fromKey(day)
                const when = `${LONG_DAY[d]}, ${date.getDate()} ${monthName(date.getMonth())} ${date.getFullYear()}`
                const said = count === 0 ? 'No contributions' : `${count} ${unit(count)}`
                return (
                  <rect
                    key={day}
                    x={w * (CELL + GAP)}
                    y={HEAD + d * (CELL + GAP)}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    fill={ramp(hue, level(count) / 4)}
                    stroke={day === today ? 'var(--ink)' : 'none'}
                    strokeWidth={day === today ? 1.5 : 0}
                    onMouseMove={(e) =>
                      show(
                        e,
                        <>
                          <strong>{said}</strong>
                          <span>{when}</span>
                        </>,
                      )
                    }
                  >
                    <title>{`${said} on ${when}`}</title>
                  </rect>
                )
              }),
            )}
          </svg>
        </div>
      </div>

      <div className="legend" style={{ justifyContent: 'flex-end' }}>
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} style={{ background: ramp(hue, l / 4), width: 11, height: 11, borderRadius: 2 }} />
        ))}
        <span>More</span>
      </div>
      <ChartTooltip tip={tip} />
    </ChartHost>
  )
}
