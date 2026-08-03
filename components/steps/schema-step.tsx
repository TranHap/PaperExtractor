"use client";

import { useMemo, useEffect, useState, useRef } from "react";
import { Upload, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useWorkflow } from "@/lib/workflow-context";
import type { Schema, SchemaField } from "@/lib/types";
import { cn } from "@/lib/utils";

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function validateInput(raw: string): Schema {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Nhập tên các cột/field cần trích xuất");

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let names: string[] = [];

  if (lines[0].includes(",")) {
    // Có dấu phẩy ở dòng đầu -> đây là CSV, chỉ lấy dòng header (dòng đầu
    // tiên), bỏ qua các dòng data phía sau (nếu có).
    const header = parseLine(lines[0].replace(/^\uFEFF/, ""));
    names = header.map((n) => n.trim()).filter(Boolean);
  } else {
    // Không có dấu phẩy -> mỗi dòng là một tên field.
    names = lines;
  }

  if (names.length === 0) throw new Error("Không tìm thấy tên field nào");

  const unique = new Set(names.map((n) => n.toLowerCase()));
  if (unique.size !== names.length) throw new Error("Có tên field bị trùng");

  const fields: SchemaField[] = names.map((name) => ({
    name,
    label: name,
    type: "string",
  }));

  return { name: "Schema", fields };
}

// Per-field metadata a user can set on top of the parsed names. Keyed by field
// name so edits survive re-parsing the raw text (as long as the name doesn't
// change). NOTE: this expects SchemaField in lib/types to accept
// type: "string" | "number" | "select" and optional description/unit/options
// — update that type if it doesn't already.
type FieldOverride = {
  type: SchemaField["type"];
  description?: string;
  unit?: string;
  options?: string[];
};

const FIELD_TYPES: { value: SchemaField["type"]; label: string }[] = [
  { value: "string", label: "Text (string)" },
  { value: "number", label: "Số (number)" },
  { value: "select", label: "Lựa chọn (select)" },
];

export function SchemaStep() {
  const { schema, setSchema, goNext } = useWorkflow();
  const [text, setText] = useState(() =>
    schema ? schema.fields.map((f) => f.name).join("\n") : "",
  );
  const [overrides, setOverrides] = useState<Record<string, FieldOverride>>(
    () => {
      if (!schema) return {};
      const initial: Record<string, FieldOverride> = {};
      for (const f of schema.fields) {
        initial[f.name] = {
          type: f.type,
          description: f.description,
          unit: f.unit,
          options: f.options,
        };
      }
      return initial;
    },
  );
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const parsed = useMemo(() => {
    try {
      return validateInput(text);
    } catch {
      return null;
    }
  }, [text]);

  const mergedFields: SchemaField[] = useMemo(() => {
    if (!parsed) return [];
    return parsed.fields.map((f) => ({ ...f, ...(overrides[f.name] ?? {}) }));
  }, [parsed, overrides]);

  function updateOverride(name: string, patch: Partial<FieldOverride>) {
    setOverrides((prev) => {
      const existing: FieldOverride = prev[name] ?? { type: "string" };
      return {
        ...prev,
        [name]: { ...existing, ...patch },
      };
    });
  }

  function apply(): Schema | null {
    try {
      const base = validateInput(text);
      const fields: SchemaField[] = base.fields.map((f) => ({
        ...f,
        ...(overrides[f.name] ?? {}),
      }));
      const finalSchema: Schema = { ...base, fields };
      setSchema(finalSchema);
      setError(null);
      return finalSchema;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Input không hợp lệ");
      return null;
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    setError(null);
  }

  return (
    <StepShell
      step={1}
      total={8}
      title="Schema"
      description="Dán tên các cột/field cần trích xuất. Mỗi dòng một tên, hoặc paste CSV header. Bấm vào 1 field để chỉnh type, mô tả, đơn vị, hoặc options."
      hideBack
      nextLabel="Lưu schema & tiếp tục"
      nextDisabled={!parsed}
      onNext={() => {
        if (apply()) goNext();
      }}
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-4" />
              Tải file .csv
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="text/csv,.csv"
              className="sr-only"
              onChange={onFile}
            />
          </div>
          <p className="mb-2 font-mono text-[11px] text-muted-foreground">
            Mỗi dòng một tên field, hoặc paste dòng header của CSV.
          </p>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder="temperature\nvoltage\ncapacity\nmaterial"
            className="min-h-[420px] font-mono text-xs leading-relaxed"
            aria-label="Schema field names"
          />
          {error && (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="size-4" />
              {error}
            </p>
          )}
        </div>

        <aside className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-medium">Danh sách field</h2>
          </div>
          {mounted && parsed ? (
            <div className="flex max-h-[560px] flex-col gap-1.5 overflow-y-auto">
              {mergedFields.map((f) => {
                const isOpen = expandedField === f.name;
                return (
                  <div
                    key={f.name}
                    className="rounded-md border border-border bg-muted/30"
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedField(isOpen ? null : f.name)}
                      className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
                    >
                      <span className="truncate text-sm font-medium">
                        {f.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">
                          {f.type}
                        </Badge>
                        {isOpen ? (
                          <ChevronUp className="size-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="size-3.5 text-muted-foreground" />
                        )}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="space-y-2 border-t border-border px-2.5 py-2.5">
                         <div>
                           <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                             Kiểu dữ liệu (type)
                           </label>
                           <select
                             value={f.type}
                             onChange={(e) =>
                               updateOverride(f.name, {
                                 type: e.target.value as SchemaField["type"],
                               })
                             }
                             className={cn(
                               "h-8 w-full rounded-md border border-input bg-background px-2 text-xs",
                               "focus:outline-none focus:ring-1 focus:ring-ring",
                             )}
                           >
                             {FIELD_TYPES.map((t) => (
                               <option key={t.value} value={t.value}>
                                 {t.label}
                               </option>
                             ))}
                           </select>
                         </div>

                          <div>
                           <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                             Mô tả (description)
                           </label>
                          <Input
                            value={f.description ?? ""}
                            onChange={(e) =>
                              updateOverride(f.name, {
                                description: e.target.value,
                              })
                            }
                            placeholder="Field này thể hiện điều gì, giúp model hiểu đúng"
                            className="h-8 text-xs"
                          />
                        </div>

                        <div>
                          <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                            Đơn vị (unit)
                          </label>
                          <Input
                            value={f.unit ?? ""}
                            onChange={(e) =>
                              updateOverride(f.name, { unit: e.target.value })
                            }
                            placeholder="mM, min, °C, mg/L..."
                            className="h-8 text-xs"
                          />
                        </div>

                        {f.type === "select" && (
                          <div>
                            <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                              Options (phân cách bởi dấu phẩy)
                            </label>
                            <Input
                              value={(f.options ?? []).join(", ")}
                              onChange={(e) =>
                                updateOverride(f.name, {
                                  options: e.target.value
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                })
                              }
                              placeholder="pH 4, pH 6, pH 8, pH 10"
                              className="h-8 text-xs"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <p className="mt-2 text-xs text-muted-foreground">
                {mergedFields.length} field
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nhập tên field để xem danh sách.
            </p>
          )}
        </aside>
      </div>
    </StepShell>
  );
}