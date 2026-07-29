"use client"

import { useMemo } from "react"
import type { DigitizedPoint } from "@/lib/types"

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

export function ScatterPreview({ points, series }: { points: DigitizedPoint[]; series: string[] }) {
  const W = 640
  const H = 340
  const pad = { l: 56, r: 16, t: 16, b: 40 }

  const { xs, ys, sx, sy } = useMemo(() => {
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)
    const yMin = Math.min(...ys)
    const yMax = Math.max(...ys)
    const xr = xMax - xMin || 1
    const yr = yMax - yMin || 1
    const sx = (x: number) => pad.l + ((x - xMin) / xr) * (W - pad.l - pad.r)
    const sy = (y: number) => H - pad.b - ((y - yMin) / yr) * (H - pad.t - pad.b)
    return { xs, ys, sx, sy, xMin, xMax, yMin, yMax }
  }, [points])

  if (points.length === 0) return null

  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)

  const ticks = 5
  const xTicks = Array.from({ length: ticks }, (_, i) => xMin + (i / (ticks - 1)) * (xMax - xMin))
  const yTicks = Array.from({ length: ticks }, (_, i) => yMin + (i / (ticks - 1)) * (yMax - yMin))

  const fmt = (n: number) => (Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0) ? n.toExponential(1) : n.toPrecision(3))

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Biểu đồ scatter dữ liệu đã số hóa">
        {/* grid + ticks */}
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.l - 8} y={sy(t)} textAnchor="end" dominantBaseline="middle" fill="var(--muted-foreground)" fontSize={10} fontFamily="var(--font-mono)">
              {fmt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={`x${i}`} x={sx(t)} y={H - pad.b + 16} textAnchor="middle" fill="var(--muted-foreground)" fontSize={10} fontFamily="var(--font-mono)">
            {fmt(t)}
          </text>
        ))}
        {/* axes */}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} stroke="var(--foreground)" strokeWidth={1.5} />
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--foreground)" strokeWidth={1.5} />
        {/* points */}
        {points.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3.5} fill={COLORS[series.indexOf(p.series) % COLORS.length]} opacity={0.85} />
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-3">
        {series.map((s, i) => (
          <span key={s} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            {s}
          </span>
        ))}
      </div>
    </div>
  )
}
