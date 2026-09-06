"use client";

import { useMemo } from "react";
import {
  Download,
  FileJson,
  Sheet,
  RotateCcw,
  Database,
  Check,
  ArrowRightCircle,
  PartyPopper,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScatterPreview } from "@/components/scatter-preview";
import { useWorkflow } from "@/lib/workflow-context";
import { buildMerged, toCsv } from "@/lib/merge";
import type { Dataset, DigitizedPoint, FieldValue, FigureItem, PaperDataset } from "@/lib/types";

function toShortName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug.length <= 40) return slug;
  const half = 20;
  return `${slug.slice(0, half)}...${slug.slice(-half)}`;
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

interface FigureBuild {
  figure: FigureItem;
  rawMerged: FieldValue[];
  dataset: Dataset;
}

export function DatasetStep() {
  const {
    schema,
    paper,
    figures,
    digitizationByFigure,
    figureContextByFigure,
    xField,
    yField,
    seriesField,
    goBack,
    reset,
    setSelectedFigure,
    setCurrentStep,
  } = useWorkflow();

  const completedFigures = useMemo(
    () =>
      figures.filter(
        (f) => (digitizationByFigure[f.id]?.points.length ?? 0) > 0,
      ),
    [figures, digitizationByFigure],
  );

  const built: FigureBuild[] = useMemo(
    () =>
      completedFigures.map((figure) => {
        const digit = digitizationByFigure[figure.id];
        const figCtx = figureContextByFigure[figure.id];
        const rawMerged = buildMerged(schema, [], figCtx?.values ?? []);
        const merged = rawMerged.filter((m) => m.value?.trim());
        const points = digit?.points ?? [];
        const dataset: Dataset = {
          schemaName: schema?.name ?? "dataset",
          paperTitle: paper?.title,
          figure,
          merged,
          points,
          xField: xField || undefined,
          yField: yField || undefined,
          seriesField: seriesField || undefined,
          generatedAt: new Date().toISOString(),
        };
        return { figure, rawMerged, dataset };
      }),
    [
      completedFigures,
      digitizationByFigure,
      figureContextByFigure,
      schema,
      paper,
      xField,
      yField,
      seriesField,
    ],
  );

  const baseNames = useMemo(() => {
    const schemaOrder = schema?.fields.map((f) => f.name) ?? [];
    const extra: string[] = [];
    for (const b of built) {
      for (const m of b.rawMerged) {
        if (!schemaOrder.includes(m.name) && !extra.includes(m.name)) {
          extra.push(m.name);
        }
      }
    }
    return [...schemaOrder, ...extra];
  }, [built, schema]);

  const totalPoints = built.reduce((sum, b) => sum + b.dataset.points.length, 0);
  const pendingFigure = figures.find(
    (f) => (digitizationByFigure[f.id]?.points.length ?? 0) === 0,
  );

  const paperLabel = paper?.title || paper?.fileName || schema?.name || "paper";
  const paperShort = toShortName(paperLabel);
  const schemaSlug = (schema?.name ?? "dataset").replace(/\s+/g, "_");

  function exportJson() {
    const paperDataset: PaperDataset = {
      schemaName: schema?.name ?? "dataset",
      paperTitle: paper?.title,
      generatedAt: new Date().toISOString(),
      figures: built.map((b) => b.dataset),
    };
    download(
      `[${paperShort}] ${schemaSlug}_dataset.json`,
      JSON.stringify(paperDataset, null, 2),
      "application/json",
    );
  }

  function exportCsv() {
    const columns: { name: string }[] = [];
    for (const name of baseNames) columns.push({ name });
    const extraAxisNames = [xField, yField, seriesField].filter(
      (n): n is string => !!n && !baseNames.includes(n),
    );
    for (const name of extraAxisNames) columns.push({ name });

    const headers = ["Source", ...columns.map((c) => c.name)];

    const rows: (string | number)[][] = [];
    for (const b of built) {
      const metaByName = new Map(b.rawMerged.map((m) => [m.name, m]));
      const source = `${paperLabel} (${b.figure.label})`;
      for (const p of b.dataset.points) {
        const row = columns.map((col) => {
          const { name } = col;
          if (name === xField) return p.x;
          if (name === yField) return p.y;
          if (name === seriesField) return p.series;
          const m = metaByName.get(name);
          if (!m) return "";
          if (m.series) return m.series === p.series ? m.value : "";
          return m.value;
        });
        rows.push([source, ...row]);
      }
    }

    download(
      `[${paperShort}] ${schemaSlug}_dataset.csv`,
      toCsv(headers, rows),
      "text/csv",
    );
  }

  function goToNextFigure() {
    if (!pendingFigure) return;
    setSelectedFigure(pendingFigure);
    setCurrentStep("digitize");
  }

  function reviewFigure(figure: FigureItem) {
    setSelectedFigure(figure);
    setCurrentStep("merge");
  }

  // Combined preview: relabel series per-figure so two figures' "Series 1"
  // don't visually merge into one color/legend entry — export values above
  // are untouched, this is display-only.
  const combinedPoints: DigitizedPoint[] = [];
  const combinedSeries: string[] = [];
  for (const b of built) {
    for (const p of b.dataset.points) {
      const label = `${b.figure.label} · ${p.series}`;
      combinedPoints.push({ ...p, series: label });
      if (!combinedSeries.includes(label)) combinedSeries.push(label);
    }
  }

  return (
    <StepShell
      stepId="dataset"
      title="Dataset"
      description="Toàn bộ figure đã số hóa của paper này, gộp thành một dataset duy nhất. Tải về JSON (đầy đủ ngữ cảnh từng figure) hoặc CSV (mỗi dòng là một điểm, kèm cột Source xác định paper + figure)."
      onBack={goBack}
      hideNext
    >
      <div className="mb-6 flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10">
            <Database className="size-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">{schema?.name ?? "dataset"}</p>
            <p className="text-xs text-muted-foreground">{paperLabel}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="border-primary/40 text-primary">
                {completedFigures.length}/{figures.length} figure
              </Badge>
              <Badge variant="outline" className="border-chart-2/40 text-chart-2">
                {totalPoints} điểm
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportJson} variant="outline" disabled={!built.length}>
            <FileJson className="size-4" />
            JSON
          </Button>
          <Button onClick={exportCsv} disabled={!totalPoints}>
            <Sheet className="size-4" />
            CSV toàn bộ
            <Download className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-dashed border-border p-4">
        {pendingFigure ? (
          <>
            <p className="text-sm text-muted-foreground">
              Còn {figures.length - completedFigures.length} figure chưa số
              hóa. Tiếp theo:{" "}
              <span className="font-medium text-foreground">
                {pendingFigure.label}
              </span>
            </p>
            <Button onClick={goToNextFigure}>
              <ArrowRightCircle className="size-4" />
              Xử lý figure tiếp theo
            </Button>
          </>
        ) : figures.length > 0 ? (
          <p className="flex items-center gap-2 text-sm text-primary">
            <PartyPopper className="size-4" />
            Đã số hóa hết {figures.length}/{figures.length} figure của paper
            này.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Chưa quét figure nào — quay lại bước "Figures & Variables".
          </p>
        )}
      </div>

      {built.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-medium">Các figure đã gộp</h2>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">Figure</th>
                  <th className="px-4 py-2 font-medium">Điểm</th>
                  <th className="px-4 py-2 font-medium">Field có giá trị</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {built.map((b) => (
                  <tr key={b.figure.id} className="border-t border-border">
                    <td className="px-4 py-2 font-medium">
                      <span className="mr-1.5 inline-flex items-center gap-1 text-primary">
                        <Check className="size-3.5" />
                      </span>
                      {b.figure.label}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {b.dataset.points.length}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {b.dataset.merged.length}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => reviewFigure(b.figure)}
                      >
                        Xem lại
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {combinedPoints.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-medium">Xem trước dữ liệu (toàn bộ paper)</h2>
          <ScatterPreview points={combinedPoints} series={combinedSeries} />
        </div>
      )}

      {combinedPoints.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium">
            Điểm dữ liệu ({combinedPoints.length})
          </h2>
          <div className="max-h-[360px] overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 text-left backdrop-blur">
                <tr>
                  <th className="px-3 py-2 font-medium">Figure</th>
                  <th className="px-3 py-2 font-medium">
                    {seriesField || "Series"}
                  </th>
                  <th className="px-3 py-2 font-medium">{xField || "X"}</th>
                  <th className="px-3 py-2 font-medium">{yField || "Y"}</th>
                </tr>
              </thead>
              <tbody>
                {built.flatMap((b) =>
                  b.dataset.points.map((p, i) => (
                    <tr key={`${b.figure.id}-${i}`} className="border-t border-border">
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {b.figure.label}
                      </td>
                      <td className="px-3 py-1.5">{p.series}</td>
                      <td className="px-3 py-1.5 font-mono tabular-nums">
                        {p.x.toPrecision(4)}
                      </td>
                      <td className="px-3 py-1.5 font-mono tabular-nums">
                        {p.y.toPrecision(4)}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-8 flex justify-center">
        <Button variant="ghost" onClick={reset}>
          <RotateCcw className="size-4" />
          Bắt đầu pipeline mới
        </Button>
      </div>
    </StepShell>
  );
}
