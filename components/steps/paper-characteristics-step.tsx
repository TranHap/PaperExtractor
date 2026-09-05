"use client";

import { useState, type ReactNode } from "react";
import {
  Loader2,
  ScanSearch,
  AlertCircle,
  FlaskConical,
  BookOpen,
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
  PaperCharacteristicsResult,
} from "@/lib/types";
import {
  chunkText,
  clip,
  mapWithConcurrency,
  mergeEntityLists,
  mergeFieldValueArrays,
  PAPER_CONTEXT_CHUNK_OVERLAP,
  PAPER_CONTEXT_CHUNK_SIZE,
  PAPER_CONTEXT_MAX_CONCURRENT_CHUNKS,
  PAPER_CONTEXT_MAX_TOTAL_CHARS,
  type EntityNames,
  type PaperContextChunkResult,
} from "@/lib/paper-context";

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
}: {
  title: string;
  icon: ReactNode;
  entities: (PaperCharacteristicMaterial | PaperCharacteristicEntity)[];
  onValueChange: (entityIndex: number, valueIndex: number, newValue: string) => void;
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
  } = useWorkflow();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Posts one task to /api/extract and throws the same friendly error the
  // old single-request flow used to, so a single chunk timing out reads the
  // same way it always has — just scoped to one chunk instead of the whole
  // scan (see run() below for why this is now split per-chunk).
  async function postExtract(body: Record<string, unknown>): Promise<any> {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error(
        `Server returned non-JSON response (status ${res.status}). This usually means the request timed out on the server. Please try again with a shorter paper, or contact support if the problem persists.`,
      );
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Trích xuất thất bại");
    return data;
  }

  // Drives the paper_context scan chunk-by-chunk from the BROWSER instead of
  // asking the server to scan the whole paper in one request. Netlify's
  // Next.js Server Handler enforces a hard ~30s timeout on this route no
  // matter what runtime/maxDuration it declares, so a single request that
  // waited on every chunk server-side routinely got killed mid-response
  // (browser saw a raw non-JSON 502). Each small per-chunk request below
  // finishes in a few seconds — comfortably under any platform timeout —
  // and the results are merged here using the same logic that used to run
  // on the server (see lib/paper-context.ts).
  async function run() {
    if (!paper) return;
    setLoading(true);
    setError(null);
    setWarning(null);
    setProgress(null);
    try {
      const clippedText = clip(paper.text, PAPER_CONTEXT_MAX_TOTAL_CHARS);
      // Only look for the columns the user's own schema actually needs —
      // replaces the old hardcoded materials-science property list (SBET,
      // pHpzc, LogKow, Abraham descriptors, etc.), which asked for far more
      // than most schemas need and slowed every chunk call down.
      const fields = (schema?.fields ?? []).map((f) => ({
        name: f.name,
        description: f.description,
        unit: f.unit,
      }));

      let knownEntities: EntityNames = {
        materials: [],
        oxidants: [],
        micropollutants: [],
      };
      try {
        knownEntities = await postExtract({
          task: "paper_context_names",
          paperText: clippedText,
        });
      } catch (e) {
        // Best-effort consistency aid, not a hard requirement — if it fails,
        // chunks below still work, just with a slightly higher chance of
        // naming the same entity differently in two chunks.
        console.error("paper_context_names failed (continuing without it):", e);
      }

      const chunks = chunkText(
        clippedText,
        PAPER_CONTEXT_CHUNK_SIZE,
        PAPER_CONTEXT_CHUNK_OVERLAP,
      );
      let done = 0;
      let chunkFailures = 0;
      setProgress({ done: 0, total: chunks.length });

      const chunkResults = await mapWithConcurrency(
        chunks,
        PAPER_CONTEXT_MAX_CONCURRENT_CHUNKS,
        async (chunkOfText, index): Promise<PaperContextChunkResult> => {
          try {
            const data = await postExtract({
              task: "paper_context_chunk",
              chunkText: chunkOfText,
              chunkIndex: index,
              totalChunks: chunks.length,
              knownEntities,
              fields,
            });
            return {
              materials: data.materials ?? [],
              oxidants: data.oxidants ?? [],
              micropollutants: data.micropollutants ?? [],
              generalConditions: data.generalConditions ?? [],
              notes: data.notes ?? "",
            };
          } catch (e) {
            // One slow/failed chunk shouldn't sink the whole scan — skip it
            // and let the rest of the paper's context still come back.
            chunkFailures++;
            console.error(`paper_context_chunk ${index} failed:`, e);
            return {
              materials: [],
              oxidants: [],
              micropollutants: [],
              generalConditions: [],
              notes: "",
            };
          } finally {
            done++;
            setProgress({ done, total: chunks.length });
          }
        },
      );

      const materials = mergeEntityLists(
        chunkResults.flatMap((r) => r.materials ?? []),
      );
      const oxidants = mergeEntityLists(
        chunkResults.flatMap((r) => r.oxidants ?? []),
      );
      const micropollutants = mergeEntityLists(
        chunkResults.flatMap((r) => r.micropollutants ?? []),
      );
      const generalConditions = chunkResults.reduce(
        (acc, r) => mergeFieldValueArrays(acc, r.generalConditions ?? []),
        [] as FieldValue[],
      );
      const notes = chunkResults
        .map((r) => r.notes?.trim())
        .filter((n): n is string => Boolean(n))
        .join(" ");

      const result: PaperCharacteristicsResult = {
        materials,
        oxidants,
        micropollutants,
        generalConditions,
        notes,
      };
      setPaperCharacteristics(result);

      if (chunkFailures > 0) {
        setWarning(
          `${chunkFailures}/${chunks.length} đoạn của paper quét chưa xong (mạng/model chậm) — dữ liệu có thể thiếu một phần. Bấm "Quét lại" để thử lại phần còn thiếu.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
    } finally {
      setLoading(false);
      setProgress(null);
    }
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
