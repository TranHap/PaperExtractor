"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { ImageUp, Loader2, Sparkles, AlertCircle } from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { FigureDigitizer } from "@/components/figure-digitizer";
import { ValuesEditor } from "@/components/values-editor";
import { useWorkflow } from "@/lib/workflow-context";
import { buildMerged } from "@/lib/merge";
import type { FieldValue, FigureContext } from "@/lib/types";
import { cn } from "@/lib/utils";

// Digitizing pixel points and filling in field values are independent tasks
// on the SAME figure — neither blocks the other, they just used to live on
// two separate wizard steps for no real reason (forcing an extra click and a
// full page swap to go back and forth between them). Putting them side by
// side removes that back-and-forth and one step from the pipeline.
export function DigitizeStep() {
  const {
    paper,
    schema,
    selectedFigure,
    digitization,
    setDigitization,
    digitizationByFigure,
    setDigitizationByFigure,
    figureContext,
    setFigureContext,
    figureContextByFigure,
    setFigureContextByFigure,
    xField,
    setXField,
    yField,
    setYField,
    seriesField,
    setSeriesField,
    paperCharacteristics,
    goBack,
    goNext,
  } = useWorkflow();
  const uploadRef = useRef<HTMLInputElement>(null);
  const previousFigureId = useRef<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);

  const currentFigureId = selectedFigure?.id ?? null;
  const allFields = schema?.fields ?? [];

  // --- Digitization: restore per-figure cache when switching figures ---
  useEffect(() => {
    if (!currentFigureId) return;
    const cached = digitizationByFigure[currentFigureId];
    setDigitization(cached ?? null);
  }, [currentFigureId, digitizationByFigure, setDigitization]);

  // --- Figure values: restore per-figure cache when switching figures ---
  // (This used to be a SEPARATE piece of state — `resolvedContext` — that
  // only got restored in one of the two old steps, so `figureContext` could
  // silently hold a stale figure's data on the Review step. Now
  // `figureContextByFigure` is the only source of truth, restored here.)
  useEffect(() => {
    if (!currentFigureId) return;
    const cached = figureContextByFigure[currentFigureId];
    setFigureContext(cached ?? null);
    setRationale(cached?.notes || null);
  }, [currentFigureId, figureContextByFigure, setFigureContext]);

  // Auto-pick the PDF page most likely to contain the selected figure.
  useEffect(() => {
    if (
      !paper ||
      !selectedFigure ||
      previousFigureId.current === selectedFigure.id
    )
      return;
    previousFigureId.current = selectedFigure.id;

    const pageTexts = paper.pageTexts ?? [];
    const searchText = [selectedFigure.label, selectedFigure.caption]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const figureNumber = selectedFigure.label.match(
      /(?:figure|fig\.?)[\s-]*(\d+[a-z]?)/i,
    )?.[1];
    const terms = [
      selectedFigure.label.toLowerCase(),
      figureNumber ? `figure ${figureNumber}` : "",
    ].filter(Boolean);
    let bestPage = -1;
    let bestScore = 0;

    pageTexts.forEach((pageText, index) => {
      const normalizedPage = pageText.toLowerCase();
      let score = 0;
      if (searchText && normalizedPage.includes(searchText)) score += 5;
      for (const term of terms) {
        if (normalizedPage.includes(term)) score += 2;
      }
      if (selectedFigure.caption) {
        const captionWords = selectedFigure.caption
          .toLowerCase()
          .split(/\s+/)
          .filter((word) => word.length > 5);
        score +=
          captionWords.filter((word) => normalizedPage.includes(word)).length *
          0.1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPage = index;
      }
    });

    if (bestPage >= 0 && paper.pageImages[bestPage])
      pickImage(paper.pageImages[bestPage]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper, selectedFigure]);

  function pickImage(url: string) {
    // Switching image is destructive: it wipes calibration + digitized
    // points. Confirm first if there's anything to lose.
    if (digitization?.imageUrl === url) return;
    if (digitization && digitization.points.length > 0) {
      const ok = window.confirm(
        `Ảnh hiện tại đã có ${digitization.points.length} điểm số hóa. Đổi sang ảnh khác sẽ xóa toàn bộ điểm và hiệu chỉnh trục đã làm. Tiếp tục?`,
      );
      if (!ok) return;
    }
    const next = {
      imageUrl: url,
      points: [],
      series: ["Series 1"],
      activeSeries: "Series 1",
    };
    setDigitization(next);
    if (currentFigureId) {
      setDigitizationByFigure({
        ...digitizationByFigure,
        [currentFigureId]: next,
      });
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => pickImage(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleDigitizationChange(
    next: Parameters<typeof setDigitization>[0],
  ) {
    setDigitization(next);
    if (currentFigureId && next && typeof next === "object") {
      setDigitizationByFigure({
        ...digitizationByFigure,
        [currentFigureId]: next,
      });
    }
  }

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
  const changingFields = useMemo(
    () => allFields.filter((f) => changingFieldNames.has(f.name)),
    [allFields, changingFieldNames],
  );
  const fixedFields = useMemo(
    () => allFields.filter((f) => !changingFieldNames.has(f.name)),
    [allFields, changingFieldNames],
  );
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
          fields: allFields.map((f) => ({
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

  const canProceed = !!digitization;

  return (
    <StepShell
      stepId="digitize"
      title="Digitize & Fill Values"
      description="Hiệu chỉnh trục X/Y và số hóa dữ liệu bên trái; điền giá trị các field còn thiếu bên phải. Hai việc này độc lập với nhau, có thể làm theo bất kỳ thứ tự nào."
      onBack={goBack}
      onNext={goNext}
      nextDisabled={!canProceed}
    >
      <div className="grid gap-6 xl:grid-cols-2">
        {/* Left: digitize */}
        <div className="min-w-0">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground">
              {selectedFigure?.label}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => uploadRef.current?.click()}
            >
              <ImageUp className="size-3.5" />
              Tải ảnh khác
            </Button>
            <input
              ref={uploadRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={onUpload}
            />
          </div>

          {paper && paper.pageImages.length > 0 && (
            <div className="mb-5 flex gap-2 overflow-x-auto pb-2">
              {paper.pageImages.map((img, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => pickImage(img)}
                  className={cn(
                    "relative shrink-0 overflow-hidden rounded-md border transition-colors",
                    digitization?.imageUrl === img
                      ? "border-primary"
                      : "border-border hover:border-primary/40",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img || "/placeholder.svg"}
                    alt={`Trang ${i + 1}`}
                    className="h-16 w-auto"
                  />
                  <span className="absolute bottom-0 right-0 bg-background/80 px-1 text-[10px] font-medium">
                    {i + 1}
                  </span>
                </button>
              ))}
            </div>
          )}

          {digitization ? (
            <FigureDigitizer
              key={currentFigureId ?? digitization.imageUrl}
              value={digitization}
              onChange={handleDigitizationChange}
            />
          ) : (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
              <p className="text-sm text-muted-foreground">
                Chọn một trang PDF hoặc tải ảnh figure để bắt đầu số hóa.
              </p>
            </div>
          )}

          <details className="group mt-5 rounded-md border border-border">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground marker:hidden">
              Đặt tên cột X / Y / Series
              <span className="ml-1 text-muted-foreground/70">
                (mặc định: x / y / series)
              </span>
            </summary>
            <div className="grid gap-4 border-t border-border p-4 md:grid-cols-3">
              {[
                {
                  label: "X-column",
                  value: xField,
                  setValue: setXField,
                  other: [yField, seriesField],
                  fallback: "x",
                },
                {
                  label: "Y-column",
                  value: yField,
                  setValue: setYField,
                  other: [xField, seriesField],
                  fallback: "y",
                },
                {
                  label: "Series-column",
                  value: seriesField,
                  setValue: setSeriesField,
                  other: [xField, yField],
                  fallback: "series",
                },
              ].map((column) => (
                <label key={column.label} className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">{column.label}</span>
                  <select
                    value={column.value}
                    onChange={(event) => column.setValue(event.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Giữ tên mặc định: {column.fallback}</option>
                    {allFields.map((field) => (
                      <option
                        key={field.name}
                        value={field.name}
                        disabled={column.other.includes(field.name)}
                      >
                        {field.label
                          ? `${field.name} (${field.label})`
                          : field.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </details>
        </div>

        {/* Right: fill values */}
        <div className="min-w-0">
          <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-border pb-4">
            <div>
              <p className="text-sm font-medium text-foreground">Fill Values</p>
              <p className="text-xs text-muted-foreground">
                Điền giá trị cho các field còn thiếu của figure
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
      </div>
    </StepShell>
  );
}
