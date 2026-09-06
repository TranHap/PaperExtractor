"use client";

import { useMemo } from "react";
import {
  Download,
  FileJson,
  Sheet,
  RotateCcw,
  Database,
  ArrowRightCircle,
  PartyPopper,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScatterPreview } from "@/components/scatter-preview";
import { useWorkflow } from "@/lib/workflow-context";
import { buildMerged, toCsv } from "@/lib/merge";
import type { Dataset, FieldValue, FigureItem } from "@/lib/types";

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toShortName(title: string): string {
  const s = slug(title);
  if (s.length <= 40) return s;
  const half = 20;
  return `${s.slice(0, half)}...${s.slice(-half)}`;
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

export function DatasetStep() {
  const {
    schema,
    paper,
    figures,
    selectedFigure,
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

  // This step exports ONE figure — the one you're working on. No merging
  // across figures: each figure gets its own file. Follows `selectedFigure`,
  // falling back to the most recent completed one. The picker below switches
  // `selectedFigure`, so it stays in sync everywhere.
  const figure = useMemo(
    () =>
      (selectedFigure &&
        completedFigures.find((f) => f.id === selectedFigure.id)) ||
      completedFigures[completedFigures.length - 1] ||
      null,
    [completedFigures, selectedFigure],
  );

  const rawMerged: FieldValue[] = useMemo(
    () =>
      figure
        ? buildMerged(schema, [], figureContextByFigure[figure.id]?.values ?? [])
        : [],
    [figure, schema, figureContextByFigure],
  );
  const filled = rawMerged.filter((m) => m.value?.trim());
  const points = figure ? digitizationByFigure[figure.id]?.points ?? [] : [];

  const dataset: Dataset | null = figure
    ? {
        schemaName: schema?.name ?? "dataset",
        paperTitle: paper?.title,
        figure,
        merged: filled,
        points,
        xField: xField || undefined,
        yField: yField || undefined,
        seriesField: seriesField || undefined,
        generatedAt: new Date().toISOString(),
      }
    : null;

  const baseNames = useMemo(() => {
    const schemaOrder = schema?.fields.map((f) => f.name) ?? [];
    const extra: string[] = [];
    for (const m of rawMerged) {
      if (!schemaOrder.includes(m.name) && !extra.includes(m.name)) {
        extra.push(m.name);
      }
    }
    return [...schemaOrder, ...extra];
  }, [rawMerged, schema]);

  const pendingFigure = figures.find(
    (f) => (digitizationByFigure[f.id]?.points.length ?? 0) === 0,
  );

  const paperLabel = paper?.title || paper?.fileName || schema?.name || "paper";
  const paperShort = toShortName(paperLabel);
  const schemaSlug = (schema?.name ?? "dataset").replace(/\s+/g, "_");
  const fileBase = figure
    ? `[${paperShort}] ${schemaSlug} - ${slug(figure.label)}`
    : `[${paperShort}] ${schemaSlug}`;

  function exportJson() {
    if (!dataset) return;
    download(
      `${fileBase}.json`,
      JSON.stringify(dataset, null, 2),
      "application/json",
    );
  }

  function exportCsv() {
    if (!figure) return;
    const columns = [...baseNames];
    for (const name of [xField, yField, seriesField]) {
      if (name && !columns.includes(name)) columns.push(name);
    }

    const headers = ["Source", ...columns];
    const metaByName = new Map(rawMerged.map((m) => [m.name, m]));
    const source = `${paperLabel} (${figure.label})`;

    const rows: (string | number)[][] = points.map((p) => {
      const row = columns.map((name) => {
        if (name === xField) return p.x;
        if (name === yField) return p.y;
        if (name === seriesField) return p.series;
        const m = metaByName.get(name);
        if (!m) return "";
        if (m.series) return m.series === p.series ? m.value : "";
        return m.value;
      });
      return [source, ...row];
    });

    download(`${fileBase}.csv`, toCsv(headers, rows), "text/csv");
  }

  function goToNextFigure() {
    if (!pendingFigure) return;
    setSelectedFigure(pendingFigure);
    setCurrentStep("digitize");
  }

  function reviewFigure(f: FigureItem) {
    setSelectedFigure(f);
    setCurrentStep("merge");
  }

  const previewSeries = useMemo(() => {
    const s: string[] = [];
    for (const p of points) if (!s.includes(p.series)) s.push(p.series);
    return s;
  }, [points]);

  return (
    <StepShell
      stepId="dataset"
      title="Dataset"
      description="Xuất dữ liệu của figure vừa số hóa. Mỗi figure là một file riêng (cột đúng theo schema, thêm cột Source ghi paper + figure) — không gộp nhiều figure."
      onBack={goBack}
      hideNext
    >
      <div className="mb-6 flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10">
            <Database className="size-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">
              {figure ? figure.label : schema?.name ?? "dataset"}
            </p>
            <p className="text-xs text-muted-foreground">{paperLabel}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="border-primary/40 text-primary">
                {points.length} điểm
              </Badge>
              <Badge variant="outline" className="border-chart-2/40 text-chart-2">
                {filled.length} field có giá trị
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {figure && (
            <Button
              variant="ghost"
              onClick={() => reviewFigure(figure)}
            >
              Xem lại
            </Button>
          )}
          <Button onClick={exportJson} variant="outline" disabled={!dataset}>
            <FileJson className="size-4" />
            JSON
          </Button>
          <Button onClick={exportCsv} disabled={!points.length}>
            <Sheet className="size-4" />
            Tải CSV
            <Download className="size-4" />
          </Button>
        </div>
      </div>

      {completedFigures.length > 1 && (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-border p-4">
          <span className="text-sm text-muted-foreground">Figure để xuất:</span>
          {completedFigures.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={f.id === figure?.id ? "default" : "outline"}
              onClick={() => setSelectedFigure(f)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      )}

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

      {figure ? (
        <>
          {points.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-3 text-sm font-medium">Xem trước dữ liệu</h2>
              <ScatterPreview points={points} series={previewSeries} />
            </div>
          )}

          {points.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-medium">
                Điểm dữ liệu ({points.length})
              </h2>
              <div className="max-h-[360px] overflow-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-left backdrop-blur">
                    <tr>
                      <th className="px-3 py-2 font-medium">
                        {seriesField || "Series"}
                      </th>
                      <th className="px-3 py-2 font-medium">{xField || "X"}</th>
                      <th className="px-3 py-2 font-medium">{yField || "Y"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1.5">{p.series}</td>
                        <td className="px-3 py-1.5 font-mono tabular-nums">
                          {p.x.toPrecision(4)}
                        </td>
                        <td className="px-3 py-1.5 font-mono tabular-nums">
                          {p.y.toPrecision(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Chưa có figure nào được số hóa. Quay lại bước Digitize để bắt đầu.
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
