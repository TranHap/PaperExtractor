"use client";

import {
  Download,
  FileJson,
  Sheet,
  RotateCcw,
  Database,
  Check,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScatterPreview } from "@/components/scatter-preview";
import { useWorkflow } from "@/lib/workflow-context";
import { buildMerged, toCsv } from "@/lib/merge";
import type { Dataset } from "@/lib/types";

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

export function DatasetStep() {
  const {
    schema,
    paper,
    experiment,
    resolvedContext,
    figureContext,
    digitization,
    selectedFigure,
    xField,
    yField,
    seriesField,
    goBack,
    reset,
    setExportedFigureIds,
    exportedFigureIds,
  } = useWorkflow();

  const base = resolvedContext ?? experiment?.values ?? [];
  const rawMerged = buildMerged(schema, base, figureContext?.values ?? []);
  const merged = rawMerged.filter((m) => m.value?.trim());
  const points = digitization?.points ?? [];

  const dataset: Dataset = {
    schemaName: schema?.name ?? "dataset",
    paperTitle: paper?.title,
    figure: selectedFigure,
    merged,
    points,
    xField: xField || undefined,
    yField: yField || undefined,
    seriesField: seriesField || undefined,
    generatedAt: new Date().toISOString(),
  };

  function exportJson() {
    download(
      `${dataset.schemaName.replace(/\s+/g, "_")}_dataset.json`,
      JSON.stringify(dataset, null, 2),
      "application/json",
    );
  }

  function exportCsv() {
    // rawMerged is already ordered to match schema.fields (buildMerged takes
    // care of that, and keeps fields with no value). x/y/series are just
    // schema fields whose value comes from the digitized point instead of
    // from experiment/figure context, so we slot them in at their real
    // schema position rather than pinning them to the front.
    const metaByName = new Map(rawMerged.map((m) => [m.name, m]));
    const baseNames = rawMerged.map((m) => m.name);
    const extraAxisNames = [xField, yField, seriesField].filter(
      (n): n is string => !!n && !baseNames.includes(n),
    );
    const fieldNames = [...baseNames, ...extraAxisNames];

    const headers = fieldNames;

    const rows = points.map((p) =>
      fieldNames.map((name) => {
        if (name === xField) return p.x;
        if (name === yField) return p.y;
        if (name === seriesField) return p.series;
        const m = metaByName.get(name);
        if (!m) return "";
        if (m.series) {
          return m.series === p.series ? m.value : "";
        }
        return m.value;
      }),
    );

    const paperShort = paper?.title
      ? toShortName(paper.title)
      : dataset.schemaName.replace(/\s+/g, "_");
    const figureName = selectedFigure?.label
      ? selectedFigure.label.replace(/\s+/g, "_")
      : "figure";
    download(
      `[${paperShort}] ${figureName}_points.csv`,
      toCsv(headers, rows),
      "text/csv",
    );
    if (selectedFigure?.id) {
      const currentIds = exportedFigureIds ?? [];
      setExportedFigureIds(
        currentIds.includes(selectedFigure.id)
          ? currentIds
          : [...currentIds, selectedFigure.id],
      );
    }
  }

  return (
    <StepShell
      step={8}
      total={8}
      title="Dataset"
      description="Kết quả cuối cùng: metadata hợp nhất gắn với từng điểm dữ liệu đã số hóa. Tải về dưới dạng JSON (đầy đủ ngữ cảnh) hoặc CSV (mỗi dòng là một điểm kèm metadata)."
      onBack={goBack}
      hideNext
    >
      <div className="mb-6 flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10">
            <Database className="size-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">{dataset.schemaName}</p>
            <p className="text-xs text-muted-foreground">
              {dataset.paperTitle ? dataset.paperTitle : "Untitled paper"}
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {selectedFigure && (
                <Badge variant="secondary">{selectedFigure.label}</Badge>
              )}
              <Badge
                variant="outline"
                className="border-primary/40 text-primary"
              >
                {merged.length} field
              </Badge>
              <Badge
                variant="outline"
                className="border-chart-2/40 text-chart-2"
              >
                {points.length} điểm
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportJson} variant="outline">
            <FileJson className="size-4" />
            JSON
          </Button>
          <Button onClick={exportCsv} disabled={!points.length}>
            <Sheet className="size-4" />
            CSV
            <Download className="size-4" />
          </Button>
        </div>
      </div>

      {points.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-medium">Xem trước dữ liệu</h2>
          <ScatterPreview points={points} series={digitization?.series ?? []} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-medium">Metadata hợp nhất</h2>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <tbody>
                {merged.map((m) => (
                  <tr
                    key={`${m.name}-${m.series ?? "global"}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="w-1/2 bg-muted/40 px-3 py-2 font-mono text-xs">
                      {m.name}
                      {m.series ? (
                        <span className="ml-1 text-muted-foreground">
                          ({m.series})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-medium">{m.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

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
      </div>

      <div className="mt-8 flex justify-center">
        <Button variant="ghost" onClick={reset}>
          <RotateCcw className="size-4" />
          Bắt đầu pipeline mới
        </Button>
      </div>
    </StepShell>
  );
}
