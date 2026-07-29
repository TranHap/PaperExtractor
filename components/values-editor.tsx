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

export function ValuesEditor({ fields, values, onChange, seriesLabel }: ValuesEditorProps) {
  const byName = new Map(values.map((v) => [v.name, v]))

  function update(name: string, value: string) {
    const existing = byName.get(name)
    const next: FieldValue = existing
      ? { ...existing, value, source: "edited by user" }
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
             <Input
              id={`field-${f.name}`}
              value={v?.value ?? ""}
              placeholder={f.type === "number" ? "0" : "—"}
              onChange={(e) => update(f.name, e.target.value)}
              className={`font-mono text-sm ${!validation.valid ? "border-destructive" : ""}`}
            />
            {seriesLabel && v && (() => {
              const label = seriesLabel(v)
              return label ? (
                <span className="ml-2 text-xs text-muted-foreground">{label}</span>
              ) : null
            })()}
            {!validation.valid && (
              <p className="mt-1.5 text-xs text-destructive">{validation.error}</p>
            )}
            {v?.source && v.source !== "edited by user" && !validation.error && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {v.source.startsWith("LLM:") && (
                  <span className="rounded-full bg-teal-500/10 px-1.5 py-0.5 text-[10px] font-medium text-teal-600 dark:text-teal-400">
                    LLM
                  </span>
                )}
                <p className="line-clamp-2 text-xs italic text-muted-foreground">
                  "{v.source}"
                </p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
