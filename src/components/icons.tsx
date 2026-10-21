interface IconProps {
  size?: number
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export function Logo({ size = 24 }: IconProps) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="12" fill="none" stroke="var(--line-strong)" strokeWidth="5" />
      <circle
        cx="16"
        cy="16"
        r="12"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray="56 19"
        transform="rotate(-90 16 16)"
      />
    </svg>
  )
}

export const Today = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="16" rx="2.5" />
    <path d="M8 3v4M16 3v4M3 10h18" />
  </svg>
)

export const Chart = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
)

export const Archive = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M2 4h20v4H2zM10 13h4" />
  </svg>
)

export const Plus = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const Left = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M14 6l-6 6 6 6" />
  </svg>
)

export const Right = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M10 6l6 6-6 6" />
  </svg>
)

export const Close = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const Dots = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2.4}>
    <path d="M12 6h.01M12 12h.01M12 18h.01" />
  </svg>
)

export const Sun = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
  </svg>
)

export const Moon = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  </svg>
)

export const Exit = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
)

export const Skip = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M5 4l10 8-10 8zM19 4v16" />
  </svg>
)

export const Trash = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </svg>
)

export const Pencil = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 20h4L20 8l-4-4L4 16z" />
  </svg>
)

export const Bell = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
)

export const Download = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </svg>
)

export const Upload = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </svg>
)

export const Folder = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)
