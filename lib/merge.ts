import type { FieldValue, Schema } from "@/lib/types"

export function buildMerged(
  schema: Schema | null,
  base: FieldValue[],
  figureValues: FieldValue[],
): FieldValue[] {
  const map = new Map<string, FieldValue>()
  for (const v of base) {
    if (v.value?.trim()) map.set(v.name, v)
  }
  for (const v of figureValues) {
    if (!v.value?.trim()) continue
    const existing = map.get(v.name)
    if (!existing || !existing.value?.trim()) map.set(v.name, v)
  }
  const order = schema?.fields.map((f) => f.name) ?? Array.from(map.keys())
  const result: FieldValue[] = []
  for (const name of order) {
    result.push(map.get(name) ?? { name, value: "", confidence: 0 })
  }
  for (const [name, v] of map) {
    if (!order.includes(name)) result.push(v)
  }
  return result
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (val: string | number) => {
    const s = String(val ?? "")
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n")
}
