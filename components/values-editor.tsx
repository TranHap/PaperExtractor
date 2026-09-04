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
  { label: string; className: string }
> = {
  reported: {
    label: "REPORTED",
    className:
      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  looked_up: {
    label: "LOOKED-UP",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  derived: {
    label: "DERIVED",
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  not_applicable: {
    label: "N/A",
    className: "bg-muted text-muted-foreground",
  },
  not_reported: {
    label: "NR",
    className: "bg-destructive/10 text-destructive",
  },
}

export function ProvenanceBadge({ provenance }: { provenance?: FieldValue["provenance"] }) {
  if (!provenance) return null
  const meta = PROVENANCE_META[provenance]
  if (!meta) return null
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        meta.className,
      )}
    >
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
    <div className="grid gap-4 md:grid-cols-2">
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
