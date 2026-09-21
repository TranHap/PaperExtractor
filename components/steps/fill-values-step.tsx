"use client";

import { useEffect, useState, useMemo } from "react";
import { Loader2, Sparkles, AlertCircle } from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { ValuesEditor } from "@/components/values-editor";
import { useWorkflow } from "@/lib/workflow-context";
import { buildMerged } from "@/lib/merge";
import {
  isEntityDependentField,
  listEntityOptions,
  lookupEntityFieldValue,
  seriesListMatchesAnyEntity,
} from "@/lib/entity-values";
import type { FieldValue, FigureContext } from "@/lib/types";

// Filling in the fixed/changing field values for a figure is independent of
// digitizing its data points — this used to share a page with Digitize, but
// squeezed into half the screen width. Split into its own step so the field
// cards get the full page width (see the comment in digitize-step.tsx).
export function FillValuesStep() {
  const {
    paper,
    schema,
    selectedFigure,
    figureContext,
    setFigureContext,
    figureContextByFigure,
    setFigureContextByFigure,
    digitizationByFigure,
    xField,
    yField,
    seriesField,
    paperCharacteristics,
    goBack,
    goNext,
  } = useWorkflow();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);

  const currentFigureId = selectedFigure?.id ?? null;
  const allFields = schema?.fields ?? [];

  // --- Figure values: restore per-figure cache when switching figures ---
  useEffect(() => {
    if (!currentFigureId) return;
    const cached = figureContextByFigure[currentFigureId];
    setFigureContext(cached ?? null);
    setRationale(cached?.notes || null);
  }, [currentFigureId, figureContextByFigure, setFigureContext]);

  const digitizationColumns = useMemo(
    () =>
      [xField, yField, seriesField].filter(
        (n): n is string => typeof n === "string" && n.trim().length > 0,
      ),
    [xField, yField, seriesField],
  );

  const changingFieldNames = useMemo(
    () => new Set(figureContext?.changingFieldNames ?? []),
    [figureContext],
  );

  // Fields whose real value differs by WHICH material/oxidant/micropollutant
  // a curve represents (SBET, pHpzc, MW...) — already known from Materials,
  // so they're resolved per series below instead of asked as one figure-wide
  // value (see lib/entity-values.ts for why a single shared value is wrong
  // here). Digitization columns are excluded — those are handled separately.
  const entityOptions = useMemo(() => listEntityOptions(paperCharacteristics), [paperCharacteristics]);
  const entityDependentFieldNames = useMemo(() => {
    if (entityOptions.length === 0) return new Set<string>();
    return new Set(
      allFields
        .filter(
          (f) =>
            !digitizationColumns.includes(f.name) &&
            isEntityDependentField(paperCharacteristics, f.name, f.description),
        )
        .map((f) => f.name),
    );
  }, [allFields, digitizationColumns, paperCharacteristics, entityOptions]);
  const entityDependentFields = useMemo(
    () => allFields.filter((f) => entityDependentFieldNames.has(f.name)),
    [allFields, entityDependentFieldNames],
  );

  const changingFields = useMemo(
    () => allFields.filter((f) => changingFieldNames.has(f.name) && !entityDependentFieldNames.has(f.name)),
    [allFields, changingFieldNames, entityDependentFieldNames],
  );
  const fixedFields = useMemo(
    () => allFields.filter((f) => !changingFieldNames.has(f.name) && !entityDependentFieldNames.has(f.name)),
    [allFields, changingFieldNames, entityDependentFieldNames],
  );

  const seriesList = digitizationByFigure[currentFigureId ?? ""]?.series ?? [];
  const seriesEntityMap = figureContext?.seriesEntityMap ?? {};

  // Only when each series/curve actually IS a different catalyst/oxidant/
  // micropollutant (series named after a known entity) does per-series
  // mapping make sense. When the series is something else instead — pH,
  // water matrix, dosage — every curve in the figure shares the SAME single
  // substance, so asking the user to map each one individually is pointless
  // busywork; see lib/entity-values.ts's seriesListMatchesAnyEntity.
  const seriesIsEntityIdentity = useMemo(
    () => seriesListMatchesAnyEntity(seriesList, paperCharacteristics),
    [seriesList, paperCharacteristics],
  );

  function persistSeriesEntityMap(nextMap: Record<string, string>) {
    persistFigureContext({
      values: figureContext?.values ?? [],
      curveLabels: figureContext?.curveLabels ?? [],
      changingVariable: figureContext?.changingVariable ?? [],
      changingFieldNames: figureContext?.changingFieldNames ?? [],
      seriesEntityMap: nextMap,
      notes: figureContext?.notes ?? "",
    });
  }

  function setSeriesEntity(seriesName: string, entityName: string) {
    const nextMap = { ...seriesEntityMap };
    if (entityName) nextMap[seriesName] = entityName;
    else delete nextMap[seriesName];
    persistSeriesEntityMap(nextMap);
  }

  // Series isn't the entity dimension (pH/water/dosage curves, one shared
  // substance) — one figure-wide choice, fanned out to every series so the
  // EXISTING per-series lookup (dataset-step's CSV join, the preview below)
  // keeps working unchanged regardless of which case this is.
  function setWholeFigureEntity(entityName: string) {
    const nextMap: Record<string, string> = {};
    if (entityName) for (const s of seriesList) nextMap[s] = entityName;
    persistSeriesEntityMap(nextMap);
  }

  const wholeFigureEntity = seriesList.length > 0 ? seriesEntityMap[seriesList[0]] ?? "" : "";

  const mergedValues = useMemo(
    () => buildMerged(schema, [], figureContext?.values ?? []),
    [schema, figureContext],
  );
  const changingValues = useMemo(
    () => mergedValues.filter((v) => changingFieldNames.has(v.name)),
    [mergedValues, changingFieldNames],
  );
  const fixedValues = useMemo(
    () => mergedValues.filter((v) => !changingFieldNames.has(v.name)),
    [mergedValues, changingFieldNames],
  );

  function persistFigureContext(next: FigureContext) {
    setFigureContext(next);
    if (currentFigureId) {
      setFigureContextByFigure({
        ...figureContextByFigure,
        [currentFigureId]: next,
      });
    }
  }

  function handleGroupChange(updatedGroup: FieldValue[], groupNames: Set<string>) {
    const untouched = (figureContext?.values ?? []).filter(
      (v) => !groupNames.has(v.name),
    );
    persistFigureContext({
      values: [...untouched, ...updatedGroup],
      curveLabels: figureContext?.curveLabels ?? [],
      changingVariable: figureContext?.changingVariable ?? [],
      changingFieldNames: figureContext?.changingFieldNames ?? [],
      notes: figureContext?.notes ?? "",
    });
  }

  async function runFillValues() {
    if (!paper || !selectedFigure) return;
    setLoading(true);
    setError(null);
    setRationale(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "figure_extract",
          figure: selectedFigure,
          // Entity-dependent fields (SBET, pHpzc...) are resolved per series
          // from Materials (see the seriesEntityMap table below) — never
          // asked from the model as a single figure-wide value here.
          fields: allFields
            .filter((f) => !entityDependentFieldNames.has(f.name))
            .map((f) => ({
              name: f.name,
              type: f.type,
              description: f.description,
              unit: f.unit,
              options: f.options,
            })),
          xField: xField || undefined,
          yField: yField || undefined,
          seriesField: seriesField || undefined,
          paperText: paper.text,
          paperContext: paperCharacteristics,
          // The page image this figure was digitized from, if any — lets
          // the model actually read the figure/table/axis labels instead of
          // relying only on pdfjs's plain-text extraction (lib/pdf.ts),
          // which can't see anything that only exists as an image (SI
          // tables rendered as images, XRD plots, chemical structures) and
          // has no idea when a table's columns got scrambled during
          // extraction. Omitted entirely when this figure hasn't been
          // digitized yet — the server falls back to text-only exactly like
          // before.
          figureImage: digitizationByFigure[currentFigureId ?? ""]?.imageUrl || undefined,
        }),
      });
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error(
          `Server returned non-JSON response (status ${res.status}). This usually means the request timed out on the server. Please try again with a shorter paper, or contact support if the problem persists.`,
        );
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Trích xuất thất bại");

      const extractedValues = data.values as FieldValue[];
      const sanitizedValues = extractedValues.map((v) =>
        digitizationColumns.includes(v.name)
          ? {
              ...v,
              value: "",
              confidence: 0,
              source: "digitization column — skipped",
              provenance: "not_applicable" as const,
            }
          : v,
      );

      persistFigureContext({
        values: sanitizedValues,
        curveLabels: data.curveLabels ?? [],
        changingVariable: data.changingVariable ?? [],
        changingFieldNames: data.changingFieldNames ?? digitizationColumns,
        notes: data.notes ?? "",
      });
      setRationale(data.notes || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
    } finally {
      setLoading(false);
    }
  }

  return (
    <StepShell
      stepId="fill-values"
      title="Fill Values"
      description="Điền giá trị cho các field còn thiếu của figure này."
      onBack={goBack}
      onNext={goNext}
    >
      <div className="min-w-0">
        <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              {selectedFigure?.label}
            </p>
            <p className="text-xs text-muted-foreground">
              Điền giá trị cho các field còn thiếu của figure
              {digitizationByFigure[currentFigureId ?? ""]?.imageUrl
                ? " · kèm ảnh trang PDF để model đọc trực tiếp"
                : " · chưa có ảnh (số hóa figure này trước để model đọc được cả hình/bảng)"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={runFillValues}
            disabled={loading || !selectedFigure}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            Trích xuất từ figure
          </Button>
        </div>

        {digitizationColumns.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3">
            <span className="text-xs font-medium text-muted-foreground">
              Cột số hóa:
            </span>
            {digitizationColumns.map((col) => {
              const role =
                col === xField
                  ? "x-col"
                  : col === yField
                    ? "y-col"
                    : col === seriesField
                      ? "series-col"
                      : null;
              return (
                <span
                  key={col}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-mono text-primary"
                >
                  {role && (
                    <span className="text-[10px] font-medium uppercase tracking-wide text-primary/60">
                      {role}
                    </span>
                  )}
                  {col}
                </span>
              );
            })}
          </div>
        )}

        {entityDependentFields.length > 0 && seriesIsEntityIdentity && (
          <div className="mb-6 rounded-lg border border-border p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Theo từng catalyst/chất (series)</h3>
              <span className="text-xs text-muted-foreground">
                {entityDependentFields.length} field lấy từ Materials
              </span>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              {entityDependentFields.map((f) => f.name).join(", ")} là đặc tính riêng của
              từng vật liệu/oxidant/chất ô nhiễm (đã có sẵn ở bước Materials) — không phải
              1 giá trị chung cho cả figure. Gán mỗi series với đúng chất tương ứng để lấy
              giá trị đúng cho từng đường; sai ở đây thì sửa lại ở Materials, không sửa tay
              ở đây.
            </p>
            {seriesList.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Chưa có series nào — đặt tên series ở bước Digitize trước.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Series</th>
                      <th className="py-1.5 pr-3 font-medium">Là chất nào?</th>
                      {entityDependentFields.map((f) => (
                        <th key={f.name} className="py-1.5 pr-3 font-mono font-medium">
                          {f.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {seriesList.map((s) => {
                      const mapped = seriesEntityMap[s] ?? "";
                      return (
                        <tr key={s} className="border-t border-border">
                          <td className="py-1.5 pr-3 font-mono">{s}</td>
                          <td className="py-1.5 pr-3">
                            <select
                              value={mapped}
                              onChange={(e) => setSeriesEntity(s, e.target.value)}
                              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                            >
                              <option value="">— chưa gán —</option>
                              {entityOptions.map((opt) => (
                                <option key={`${opt.category}-${opt.name}`} value={opt.name}>
                                  {opt.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          {entityDependentFields.map((f) => {
                            const resolved = mapped
                              ? lookupEntityFieldValue(paperCharacteristics, mapped, f.name, f.description)
                              : undefined;
                            return (
                              <td key={f.name} className="py-1.5 pr-3">
                                {resolved?.value ? (
                                  <span className="font-mono font-medium">{resolved.value}</span>
                                ) : (
                                  <span className="text-muted-foreground">
                                    {mapped ? "không có ở Materials" : "—"}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {entityDependentFields.length > 0 && !seriesIsEntityIdentity && (
          <div className="mb-6 rounded-lg border border-border p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Chất dùng trong figure này</h3>
              <span className="text-xs text-muted-foreground">
                {entityDependentFields.length} field lấy từ Materials
              </span>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Series ở figure này là {seriesField || "biến"} thay đổi (không phải tên chất) —
              nghĩa là cả figure chỉ dùng CHUNG 1 chất, nên {entityDependentFields.map((f) => f.name).join(", ")}{" "}
              chỉ cần chọn 1 lần cho cả figure, không cần gán theo từng series.
            </p>
            {seriesList.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Chưa có series nào — đặt tên series ở bước Digitize trước.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <select
                  value={wholeFigureEntity}
                  onChange={(e) => setWholeFigureEntity(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">— chưa chọn —</option>
                  {entityOptions.map((opt) => (
                    <option key={`${opt.category}-${opt.name}`} value={opt.name}>
                      {opt.name}
                    </option>
                  ))}
                </select>
                {entityDependentFields.map((f) => {
                  const resolved = wholeFigureEntity
                    ? lookupEntityFieldValue(paperCharacteristics, wholeFigureEntity, f.name, f.description)
                    : undefined;
                  return (
                    <span key={f.name} className="font-mono">
                      {f.name}={resolved?.value || "—"}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="mb-4 flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="size-4" />
            {error}
          </p>
        )}

        {figureContext ? (
          <div className="space-y-8">
            {changingFields.length > 0 && (
              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    Biến thay đổi trong figure
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {changingFields.length} field · để trống theo thiết kế
                  </span>
                </div>
                <ValuesEditor
                  fields={changingFields}
                  values={changingValues}
                  onChange={(next) => handleGroupChange(next, changingFieldNames)}
                  seriesLabel={(v) => v.series || null}
                />
              </div>
            )}

            {fixedFields.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                  Giá trị cố định
                </h3>
                <ValuesEditor
                  fields={fixedFields}
                  values={fixedValues}
                  onChange={(next) =>
                    handleGroupChange(next, new Set(fixedFields.map((f) => f.name)))
                  }
                  seriesLabel={(v) => v.series || null}
                />
              </div>
            )}

            {rationale && (
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                <span aria-hidden className="mt-0.5">
                  ⓘ
                </span>
                {rationale}
              </p>
            )}
          </div>
        ) : (
          <div className="flex min-h-[160px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-center">
            <p className="text-sm text-muted-foreground">
              {loading
                ? "Đang đọc paper và điền các field còn thiếu..."
                : "Chưa có giá trị nào cho figure này."}
            </p>
          </div>
        )}
      </div>
    </StepShell>
  );
}
