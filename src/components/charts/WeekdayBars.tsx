import { WEEKDAY_NAME } from '../../lib/date'
import type { WeekdayStat } from '../../lib/stats'
import { ChartHost, ChartTooltip, pct, useTooltip } from './chartkit'

interface WeekdayBarsProps {
  stats: WeekdayStat[]
  hue?: string
}

/**
 * Which weekdays actually hold up.
 *
 * Horizontal, because the labels are words. Every bar is directly labelled with
 * its rate, so the chart needs no axis and no legend - one series, named by the
 * panel title.
 */
export function WeekdayBars({ stats, hue }: WeekdayBarsProps) {
  const { tip, show, hide } = useTooltip()
  const paint = hue ?? 'var(--ink)'
  const anyData = stats.some((s) => s.scheduled > 0)

  if (!anyData) {
    return <p className="help">Nothing scheduled in this window yet.</p>
  }

  const best = stats.reduce((a, b) => (b.rate > a.rate ? b : a))
  const worst = stats.filter((s) => s.scheduled > 0).reduce((a, b) => (b.rate < a.rate ? b : a))

  return (
    <ChartHost>
      <div className="wd-list" onMouseLeave={hide}>
        {stats.map((s) => (
          <div
            className="wd-row"
            key={s.weekday}
            onMouseMove={(e) =>
              show(
                e,
                <>
                  <strong>{WEEKDAY_NAME[s.weekday]}</strong>
                  <span>
                    {s.done} of {s.scheduled} finished
                  </span>
                </>,
              )
            }
          >
            <span className="wd-name mono">{WEEKDAY_NAME[s.weekday]}</span>
            <span className="wd-track">
              <span
                className="wd-fill"
                style={{
                  width: `${Math.max(s.rate * 100, s.scheduled ? 1.5 : 0)}%`,
                  background: paint,
                  // The strongest and weakest days carry full weight; the rest recede.
                  opacity: s.weekday === best.weekday || s.weekday === worst.weekday ? 1 : 0.55,
                }}
              />
            </span>
            <span className="wd-val mono">{s.scheduled ? pct(s.rate) : '-'}</span>
          </div>
        ))}
      </div>
      <ChartTooltip tip={tip} />
    </ChartHost>
  )
}
