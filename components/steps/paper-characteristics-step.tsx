"use client";

import { type ReactNode, useState } from "react";
import {
  Loader2,
  ScanSearch,
  AlertCircle,
  FlaskConical,
  BookOpen,
  Search,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProvenanceBadge } from "@/components/values-editor";
import { useWorkflow } from "@/lib/workflow-context";
import type {
  FieldValue,
  PaperCharacteristicEntity,
  PaperCharacteristicMaterial,
} from "@/lib/types";
import type { LserdRow } from "@/app/api/lserd/route";

// Abraham solvation parameters (E, S, A, B, V) for a micropollutant are
// almost never stated in the paper itself — they come from an external
// reference database (UFZ LSERD, see app/api/lserd/route.ts). Several
// literature sources usually exist for the same compound with slightly
// different regressed values, so this is a manual pick from search results
// rather than an auto-fill: the user searches by compound name and chooses
// which row's E/S/A/B/V to keep.
const LSERD_FIELD_NAMES = ["E", "S", "A", "B", "V"] as const;

function upsertLserdRow(values: FieldValue[], row: LserdRow): FieldValue[] {
  const source = `LSERD${row.shortCite ? `: ${row.shortCite}` : ""}`;
  const next = [...values];
  for (const name of LSERD_FIELD_NAMES) {
    const value = row[name];
    if (!value || value === "-") continue;
    const idx = next.findIndex((v) => v.name === name);
    const updated: FieldValue = {
      name,
      value,
      confidence: 1,
      source,
      provenance: "looked_up",
      originalValue: undefined,
      conversionNote: row.citation || undefined,
    };
    if (idx >= 0) next[idx] = updated;
    else next.push(updated);
  }
  return next;
}

function LserdLookup({ entityName, onApply }: { entityName: string; onApply: (row: LserdRow) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<LserdRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/lserd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: entityName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Tra cứu thất bại");
      setRows(data.rows as LserdRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tra cứu thất bại");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2">
      <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={search} disabled={loading}>
        {loading ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}
        Tra LSERD (E/S/A/B/V)
      </Button>
      {open && (
        <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
          {loading && <p className="text-[11px] text-muted-foreground">Đang tra cứu...</p>}
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          {!loading && !error && rows && rows.length === 0 && (
            <p className="text-[11px] text-muted-foreground">Không tìm thấy "{entityName}" trong LSERD.</p>
          )}
          {!loading && rows && rows.length > 0 && (
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="px-1.5 py-1 font-medium">Name</th>
                    <th className="px-1.5 py-1 font-medium">E</th>
                    <th className="px-1.5 py-1 font-medium">S</th>
                    <th className="px-1.5 py-1 font-medium">A</th>
                    <th className="px-1.5 py-1 font-medium">B</th>
                    <th className="px-1.5 py-1 font-medium">V</th>
                    <th className="px-1.5 py-1 font-medium">Nguồn</th>
                    <th className="px-1.5 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-1.5 py-1 font-mono">{r.name}</td>
                      <td className="px-1.5 py-1">{r.E || "—"}</td>
                      <td className="px-1.5 py-1">{r.S || "—"}</td>
                      <td className="px-1.5 py-1">{r.A || "—"}</td>
                      <td className="px-1.5 py-1">{r.B || "—"}</td>
                      <td className="px-1.5 py-1">{r.V || "—"}</td>
                      <td className="px-1.5 py-1 text-muted-foreground">{r.shortCite}</td>
                      <td className="px-1.5 py-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => {
                            onApply(r);
                            setOpen(false);
                          }}
                        >
                          Dùng
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// A manual edit replaces whatever the AI determined, so drop its
// provenance/original-value/conversion-note — same convention as
// ValuesEditor's `update()`, so an edited cell reads the same way everywhere
// in the app.
function withEditedValue(
  values: FieldValue[],
  index: number,
  newValue: string,
): FieldValue[] {
  return values.map((v, i) =>
    i === index
      ? {
          ...v,
          value: newValue,
          source: "edited by user",
          provenance: undefined,
          originalValue: undefined,
          conversionNote: undefined,
        }
      : v,
  );
}

function EditableValueCell({
  value,
  onChange,
}: {
  value: FieldValue;
  onChange: (newValue: string) => void;
}) {
  return (
    <input
      value={value.value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="—"
      aria-label={`Giá trị của ${value.name}`}
      className="w-full min-w-[90px] rounded border border-transparent bg-transparent px-1 py-0.5 font-medium focus:border-input focus:bg-background focus:outline-none"
    />
  );
}

function EntitySection({
  title,
  icon,
  entities,
  onValueChange,
  onLserdApply,
}: {
  title: string;
  icon: ReactNode;
  entities: (PaperCharacteristicMaterial | PaperCharacteristicEntity)[];
  onValueChange: (entityIndex: number, valueIndex: number, newValue: string) => void;
  /** Only passed for the micropollutants section — enables the LSERD lookup button per entity. */
  onLserdApply?: (entityIndex: number, row: LserdRow) => void;
}) {
  if (entities.length === 0) return null;
  return (
    <div>
      <h2 className="mb-3 text-sm font-medium flex items-center gap-2">
        {icon}
        {title} ({entities.length})
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        {entities.map((entity, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-sm font-semibold">{entity.name}</span>
              {"role" in entity && entity.role && (
                <Badge variant="secondary" className="text-[10px]">
                  {entity.role}
                </Badge>
              )}
            </div>
            {entity.values.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/60 text-left">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Property</th>
                      <th className="px-3 py-1.5 font-medium">Value</th>
                      <th className="px-3 py-1.5 font-medium">Status</th>
                      <th className="px-3 py-1.5 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entity.values.map((v, j) => (
                      <tr key={j} className="border-t border-border">
                        <td className="px-3 py-1 font-mono">{v.name}</td>
                        <td className="px-3 py-1">
                          <EditableValueCell
                            value={v}
                            onChange={(newValue) => onValueChange(i, j, newValue)}
                          />
                          {v.originalValue && (
                            <span className="ml-1 font-normal text-muted-foreground">
                              (gốc: {v.originalValue})
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1">
                          <ProvenanceBadge provenance={v.provenance} />
                        </td>
                        <td className="px-3 py-1 text-muted-foreground">
                          {v.source || ""}
                          {v.conversionNote && (
                            <span className="block text-[10px] text-muted-foreground/80">
                              {v.conversionNote}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No characteristics extracted
              </p>
            )}
            {onLserdApply && (
              <LserdLookup
                entityName={entity.name}
                onApply={(row) => onLserdApply(i, row)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PaperCharacteristicsStep() {
  const {
    paper,
    schema,
    goBack,
    goNext,
    paperCharacteristics,
    setPaperCharacteristics,
    paperCharacteristicsStatus,
    paperCharacteristicsProgress: progress,
    paperCharacteristicsError: error,
    paperCharacteristicsWarning: warning,
    runPaperCharacteristicsScan,
  } = useWorkflow();
  const loading = paperCharacteristicsStatus === "running";

  // The actual scan (chunking, per-chunk requests, merging) now lives in
  // WorkflowProvider (lib/workflow-context.tsx) — not here — specifically so
  // it keeps running in the background if you navigate to another step
  // (Figures & Variables, Digitize...) while it's still going, instead of
  // being silently abandoned or double-triggered when you come back.
  function run() {
    if (!paper) return;
    runPaperCharacteristicsScan(paper, schema);
  }

  function exportJson() {
    if (!paperCharacteristics) return;
    download(
      "paper_context.json",
      JSON.stringify(paperCharacteristics, null, 2),
      "application/json",
    );
  }

  function updateEntityValue(
    category: "materials" | "oxidants" | "micropollutants",
    entityIndex: number,
    valueIndex: number,
    newValue: string,
  ) {
    if (!paperCharacteristics) return;
    const list = paperCharacteristics[category].map((entity, i) =>
      i === entityIndex
        ? { ...entity, values: withEditedValue(entity.values, valueIndex, newValue) }
        : entity,
    );
    setPaperCharacteristics({ ...paperCharacteristics, [category]: list });
  }

  function applyLserdRow(entityIndex: number, row: LserdRow) {
    if (!paperCharacteristics) return;
    const list = paperCharacteristics.micropollutants.map((entity, i) =>
      i === entityIndex ? { ...entity, values: upsertLserdRow(entity.values, row) } : entity,
    );
    setPaperCharacteristics({ ...paperCharacteristics, micropollutants: list });
  }

  function updateGeneralCondition(valueIndex: number, newValue: string) {
    if (!paperCharacteristics) return;
    setPaperCharacteristics({
      ...paperCharacteristics,
      generalConditions: withEditedValue(
        paperCharacteristics.generalConditions,
        valueIndex,
        newValue,
      ),
    });
  }

  return (
    <StepShell
      stepId="paper-characteristics"
      title="Materials"
      description="Trích xuất toàn bộ đặc tính vật liệu và hằng số chung từ paper. Kết quả sẽ được dùng làm nguồn dự phòng khi trích xuất giá trị figure — có thể sửa trực tiếp nếu model trích sai."
      onBack={goBack}
      onNext={goNext}
      nextDisabled={!paperCharacteristics}
      nextLabel="Xác nhận & tiếp tục"
    >
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {paperCharacteristics
            ? `Đã trích xuất ${paperCharacteristics.materials.length} vật liệu`
            : "Chưa trích xuất"}
        </p>
        <div className="flex gap-2">
          {paperCharacteristics && (
            <Button variant="outline" size="sm" onClick={exportJson}>
              <BookOpen className="size-4" />
              Tải JSON
            </Button>
          )}
          <Button
            onClick={run}
            disabled={loading}
            variant={paperCharacteristics ? "outline" : "default"}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ScanSearch className="size-4" />
            )}
            <span>
              {loading && progress
                ? `Đang quét đoạn ${progress.done}/${progress.total}...`
                : paperCharacteristics
                  ? "Quét lại"
                  : "Trích xuất đặc tính paper"}
            </span>
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-4 flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      {warning && (
        <p className="mb-4 flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
          <AlertCircle className="size-4" />
          {warning}
        </p>
      )}

      {paperCharacteristics && (
        <div className="space-y-6">
          <p className="text-xs text-muted-foreground">
            Bấm vào một giá trị để chỉnh sửa trực tiếp nếu model trích sai.
          </p>

          <EntitySection
            title="Vật liệu"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.materials}
            onValueChange={(ei, vi, nv) => updateEntityValue("materials", ei, vi, nv)}
          />

          <EntitySection
            title="Chất oxy hóa"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.oxidants}
            onValueChange={(ei, vi, nv) => updateEntityValue("oxidants", ei, vi, nv)}
          />

          <EntitySection
            title="Chất ô nhiễm"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.micropollutants}
            onValueChange={(ei, vi, nv) => updateEntityValue("micropollutants", ei, vi, nv)}
            onLserdApply={applyLserdRow}
          />

          {paperCharacteristics.generalConditions.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-medium">
                Điều kiện chung (General Conditions)
              </h2>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/60 text-left">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Property</th>
                      <th className="px-3 py-1.5 font-medium">Value</th>
                      <th className="px-3 py-1.5 font-medium">Status</th>
                      <th className="px-3 py-1.5 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paperCharacteristics.generalConditions.map((v, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1 font-mono">{v.name}</td>
                        <td className="px-3 py-1">
                          <EditableValueCell
                            value={v}
                            onChange={(newValue) => updateGeneralCondition(i, newValue)}
                          />
                        </td>
                        <td className="px-3 py-1">
                          <ProvenanceBadge provenance={v.provenance} />
                        </td>
                        <td className="px-3 py-1 text-muted-foreground">
                          {v.source || ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {paperCharacteristics.notes && (
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <span aria-hidden className="mt-0.5">
                ⓘ
              </span>
              {paperCharacteristics.notes}
            </p>
          )}
        </div>
      )}

      {!paperCharacteristics && !loading && !error && (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
          <p className="text-sm text-muted-foreground">
            Bấm "Trích xuất đặc tính paper" để bóc tách toàn bộ vật liệu và hằng
            số.
          </p>
        </div>
      )}
    </StepShell>
  );
}
