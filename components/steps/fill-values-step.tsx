"use client";

import { useEffect, useState, useMemo } from "react";
import { Loader2, Sparkles, AlertCircle } from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { ValuesEditor } from "@/components/values-editor";
import { useWorkflow } from "@/lib/workflow-context";
import { buildMerged } from "@/lib/merge";
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
    </StepShell>
  );
}
