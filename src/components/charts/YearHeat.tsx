import { useLayoutEffect, useRef } from 'react'
import { addDays, fromKey, monthName, todayKey, WEEKDAY_SHORT } from '../../lib/date'
import { dayShare } from '../../lib/stats'
import type { AppData } from '../../lib/types'
import { ChartHost, ChartTooltip, pct, ramp, useTooltip } from './chartkit'

interface YearHeatProps {
  data: AppData
  /** One habit, or every habit when omitted. */
  habitId?: string
  hue?: string
  weeks?: number
}

const CELL = 11
const GAP = 3
const ROWS = 7
const HEAD = 14

/**
 * A year at a glance, one cell per day, magnitude as a sequential ramp.
 *
 * Deliberately one hue: this answers "how consistent have I been", which is a
 * magnitude question, and a rainbow would invent categories that are not in the
 * data.
 */
export function YearHeat({ data, habitId, hue, weeks = 53 }: YearHeatProps) {
  const scroller = useRef<HTMLDivElement>(null)

  // On a narrow screen the year does not fit: open at the newest weeks.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])
  const { tip, show, hide } = useTooltip()
  const paint = hue ?? 'var(--ink)'
  const today = todayKey()

  // Wind back to the Sunday that starts the grid so weekday rows line up.
  const todayWeekday = fromKey(today).getDay()
  const lastColumnStart = addDays(today, -todayWeekday)
  const firstDay = addDays(lastColumnStart, -(weeks - 1) * 7)

  const W = weeks * CELL + (weeks - 1) * GAP
  const H = HEAD + ROWS * CELL + (ROWS - 1) * GAP

  const columns = Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: ROWS }, (_, d) => addDays(firstDay, w * 7 + d)),
  )

  // A month label at each column where a new month begins.
  const labels: { x: number; text: string }[] = []
  let lastMonth = -1
  columns.forEach((col, w) => {
    const m = fromKey(col[0]).getMonth()
    if (m !== lastMonth) {
      lastMonth = m
      labels.push({ x: w * (CELL + GAP), text: monthName(m) })
    }
  })

  return (
    <ChartHost>
      <div className="year-scroll" ref={scroller}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label={`Daily completion over the last ${weeks} weeks`}
          onMouseLeave={hide}
        >
          {labels.map((l, i) => (
            // Drop a label that would collide with the one before it.
            i > 0 && l.x - labels[i - 1].x < 26 ? null : (
              <text key={`${l.text}-${l.x}`} x={l.x} y={9} className="cal-dow-text">
                {l.text}
              </text>
            )
          ))}

          {columns.map((col, w) =>
            col.map((day, d) => {
              if (day > today) return null
              const share = dayShare(data, day, habitId)
              const date = fromKey(day)
              return (
                <rect
                  key={day}
                  x={w * (CELL + GAP)}
                  y={HEAD + d * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={2.5}
                  fill={ramp(paint, share)}
                  stroke={day === today ? 'var(--ink)' : 'none'}
                  strokeWidth={day === today ? 1.5 : 0}
                  onMouseMove={(e) =>
                    show(
                      e,
                      <>
                        <strong>
                          {WEEKDAY_SHORT[d]} {date.getDate()} {monthName(date.getMonth())}
                        </strong>
                        <span>{pct(share)} finished</span>
                      </>,
                    )
                  }
                >
                  <title>{`${day}: ${pct(share)}`}</title>
                </rect>
              )
            }),
          )}
        </svg>
      </div>

      <div className="legend" style={{ justifyContent: 'flex-end' }}>
        <span>Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((s) => (
          <i key={s} style={{ background: ramp(paint, s), width: 11, height: 11, borderRadius: 2.5 }} />
        ))}
        <span>More</span>
      </div>
      <ChartTooltip tip={tip} />
    </ChartHost>
  )
}
