"use client"

import type { FieldValue, SchemaField } from "@/lib/types"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { validateFieldValue } from "@/lib/validation"
import { cn } from "@/lib/utils"

interface ValuesEditorProps {
  fields: SchemaField[]
  values: FieldValue[]
  onChange: (values: FieldValue[]) => void
  seriesLabel?: (value: FieldValue) => string | null
}

const PROVENANCE_META: Record<
  NonNullable<FieldValue["provenance"]>,
  { label: string; className: string; dotClassName: string }
> = {
  reported: {
    label: "reported",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    dotClassName: "bg-emerald-500",
  },
  looked_up: {
    label: "looked-up",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dotClassName: "bg-amber-500",
  },
  derived: {
    label: "derived",
    className: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
    dotClassName: "bg-violet-500",
  },
  not_applicable: {
    label: "n/a",
    className: "bg-muted text-muted-foreground",
    dotClassName: "bg-muted-foreground/50",
  },
  not_reported: {
    label: "not reported",
    className: "bg-destructive/10 text-destructive",
    dotClassName: "bg-destructive",
  },
}

// Dot + pill, same three colors everywhere a value's provenance shows up
// (here, the Materials entity tables, Dataset preview) — a small, consistent
// "how much do I trust this" signal instead of a loud full-color badge.
export function ProvenanceBadge({ provenance }: { provenance?: FieldValue["provenance"] }) {
  if (!provenance) return null
  const meta = PROVENANCE_META[provenance]
  if (!meta) return null
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
        meta.className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", meta.dotClassName)} />
      {meta.label}
    </span>
  )
}

export function ValuesEditor({ fields, values, onChange, seriesLabel }: ValuesEditorProps) {
  const byName = new Map(values.map((v) => [v.name, v]))

  function update(name: string, value: string) {
    const existing = byName.get(name)
    // A manual edit replaces whatever the AI determined, so drop its
    // provenance/original-value/conversion-note — they'd otherwise linger and
    // describe a value that's no longer there.
    const next: FieldValue = existing
      ? {
          ...existing,
          value,
          source: "edited by user",
          provenance: undefined,
          originalValue: undefined,
          conversionNote: undefined,
        }
      : { name, value, confidence: 1, source: "edited by user" }
    const others = values.filter((v) => v.name !== name)
    onChange([...others, next])
  }

  return (
    // @container (not a viewport breakpoint): this editor gets embedded in
    // layouts that are themselves already split into columns (e.g. the
    // Digitize step's digitize/fill-values split), so a viewport-relative
    // `md:` breakpoint would force 2 field columns based on the WHOLE
    // page's width even when this editor's own column is much narrower —
    // squeezing each field card (label, description, source quote) into a
    // sliver. Container queries make it respond to its actual width instead.
    <div className="@container/values-editor grid gap-4 @lg/values-editor:grid-cols-2">
      {fields.map((f) => {
        const v = byName.get(f.name)
        const validation = v?.value ? validateFieldValue(f, v.value) : { valid: true }
        return (
          <div
            key={f.name}
            className={cn(
              "rounded-lg border bg-card p-4",
              !validation.valid && "border-destructive",
            )}
          >
             <div className="mb-2 flex items-center justify-between">
               <div>
                 <Label htmlFor={`field-${f.name}`} className="text-sm font-medium">
                   {f.label || f.name}
                   {f.unit ? <span className="ml-1 text-muted-foreground">({f.unit})</span> : null}
                 </Label>
               </div>
             </div>
             {f.description && (
               <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{f.description}</p>
             )}
             {f.type === "select" && f.options && f.options.length > 0 ? (
               <select
                 id={`field-${f.name}`}
                 value={v?.value ?? ""}
                 onChange={(e) => update(f.name, e.target.value)}
                 className={cn(
                   "h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm",
                   !validation.valid && "border-destructive",
                 )}
               >
                 <option value="">—</option>
                 {v?.value && !f.options.includes(v.value) && (
                   <option value={v.value}>{v.value} (không khớp option)</option>
                 )}
                 {f.options.map((opt) => (
                   <option key={opt} value={opt}>
                     {opt}
                   </option>
                 ))}
               </select>
             ) : (
               <Input
                id={`field-${f.name}`}
                value={v?.value ?? ""}
                placeholder={f.type === "number" ? "0" : "—"}
                onChange={(e) => update(f.name, e.target.value)}
                className={`font-mono text-sm ${!validation.valid ? "border-destructive" : ""}`}
              />
             )}
            {seriesLabel && v && (() => {
              const label = seriesLabel(v)
              return label ? (
                <span className="ml-2 text-xs text-muted-foreground">{label}</span>
              ) : null
            })()}
            {!validation.valid && (
              <p className="mt-1.5 text-xs text-destructive">{validation.error}</p>
            )}
            {v?.originalValue && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Giá trị gốc: <span className="font-mono">{v.originalValue}</span> → {v.value}
              </p>
            )}
            {v?.source && v.source !== "edited by user" && !validation.error && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <ProvenanceBadge provenance={v.provenance} />
                <p className="line-clamp-2 text-xs italic text-muted-foreground">
                  "{v.source}"
                </p>
              </div>
            )}
            {v?.conversionNote && (
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/80">
                {v.conversionNote}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
