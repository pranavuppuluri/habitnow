import { colorVar, inkVar, type Habit } from '../lib/types'

interface TickProps {
  habit: Habit
  value: number
  skipped: boolean
  onClick: () => void
  size?: number
}

/**
 * The check control. A plain yes/no habit reads as a ring that fills; a counted
 * habit shows how many of the target are in so far, so one glance answers
 * "how much is left" rather than just "done or not".
 */
export function Tick({ habit, value, skipped, onClick, size = 38 }: TickProps) {
  const color = colorVar(habit.color)
  // White is not automatically legible on a filled ring: on orange it is 3.34:1,
  // where the dark ink reaches 5.31:1. Each colour carries whichever ink measured
  // better against it.
  const ink = inkVar(habit.color)
  const done = value >= habit.target
  const counted = habit.target > 1
  const share = Math.min(1, habit.target === 0 ? 0 : value / habit.target)

  const r = size / 2 - 2.5
  const circumference = 2 * Math.PI * r
  const label = skipped
    ? `${habit.name}: skipped today`
    : habit.github
      ? `${habit.name}: ${value} ${habit.unit} on GitHub, tap to refresh`
      : done
      ? `${habit.name}: done, tap to undo`
      : counted
        ? `${habit.name}: ${value} of ${habit.target} ${habit.unit}, tap to add one`
        : `${habit.name}: tap to mark done`

  return (
    <button className="tick" style={{ width: size, height: size }} onClick={onClick} title={label}>
      <span className="sr-only">{label}</span>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill={done && !skipped ? color : 'transparent'}
          stroke={skipped ? 'var(--line-strong)' : color}
          strokeWidth="2.5"
          opacity={skipped ? 1 : done ? 1 : 0.28}
        />
        {!done && !skipped && share > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${share * circumference} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      {skipped ? (
        <span className="tick-glyph" style={{ color: 'var(--ink-3)', fontSize: size * 0.4 }}>
          &ndash;
        </span>
      ) : done ? (
        <svg className="tick-glyph" width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 13l4.5 4.5L19 7"
            fill="none"
            stroke={ink}
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : counted ? (
        <span className="tick-count" style={{ color, fontSize: size * 0.29 }}>
          {value}
        </span>
      ) : null}
    </button>
  )
}
