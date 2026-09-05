"use client";

import {
  Layers,
  Image as ImageIcon,
  ScatterChart,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Badge } from "@/components/ui/badge";
import { ProvenanceBadge } from "@/components/values-editor";
import { useWorkflow } from "@/lib/workflow-context";
import { buildMerged } from "@/lib/merge";

export function MergeStep() {
  const {
    schema,
    figureContext,
    digitization,
    selectedFigure,
    xField,
    yField,
    seriesField,
    goBack,
    goNext,
  } = useWorkflow();

  const merged = buildMerged(schema, [], figureContext?.values ?? []);
  const filled = merged.filter((m) => m.value?.trim());

  const sources = [
    {
      icon: ImageIcon,
      title: "Giá trị đã điền",
      count: filled.length,
      label: "field figure",
    },
    {
      icon: ScatterChart,
      title: "Điểm đã số hóa",
      count: digitization?.points.length ?? 0,
      label: "điểm dữ liệu",
    },
  ];

  return (
    <StepShell
      stepId="merge"
      title="Review"
      description="Xem lại giá trị đã điền và các điểm đã số hóa của figure này trước khi gộp vào dataset chung của paper."
      onBack={goBack}
      onNext={goNext}
      nextLabel="Tạo Dataset"
    >
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        {sources.map((s) => (
          <div
            key={s.title}
            className="rounded-lg border border-border bg-card p-4"
          >
            <div className="mb-2 flex items-center gap-2">
              <s.icon className="size-4 text-primary" />
              <span className="text-sm font-medium">{s.title}</span>
            </div>
            <p className="text-2xl font-semibold tabular-nums">{s.count}</p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-2">
        <Layers className="size-4 text-primary" />
        <h2 className="text-sm font-medium">
          Bản ghi hợp nhất — {filled.length}/{merged.length} field có giá trị
        </h2>
        {selectedFigure && (
          <Badge variant="secondary">{selectedFigure.label}</Badge>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Field</th>
              <th className="px-4 py-2 font-medium">Giá trị</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Nguồn</th>
            </tr>
          </thead>
          <tbody>
            {merged.map((m) => {
              const columnRole =
                m.name === xField
                  ? "x-column"
                  : m.name === yField
                    ? "y-column"
                    : m.name === seriesField
                      ? "series-column"
                      : null;

              return (
                <tr key={m.name} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-xs">
                    {m.name}
                  </td>
                  <td className="px-4 py-2">
                    {m.value?.trim() ? (
                      <span className="font-medium">{m.value}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {m.originalValue && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (gốc: {m.originalValue})
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <ProvenanceBadge provenance={m.provenance} />
                  </td>
                  <td className="px-4 py-2">
                    {columnRole || m.value?.trim() ? (
                      <Badge
                        variant="outline"
                        className={
                          columnRole
                            ? "border-chart-2/40 text-chart-2"
                            : "border-primary/40 text-primary"
                        }
                      >
                        {columnRole ?? "figure"}
                      </Badge>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </StepShell>
  );
}
