"use client";

import { useState, type ReactNode } from "react";
import {
  Loader2,
  ScanSearch,
  AlertCircle,
  Check,
  FlaskConical,
  BookOpen,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWorkflow } from "@/lib/workflow-context";
import type {
  PaperCharacteristicMaterial,
  PaperCharacteristicEntity,
  PaperCharacteristicsResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function EntitySection({
  title,
  icon,
  entities,
}: {
  title: string;
  icon: ReactNode;
  entities: (PaperCharacteristicMaterial | PaperCharacteristicEntity)[];
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
                      <th className="px-3 py-1.5 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entity.values.map((v, j) => (
                      <tr key={j} className="border-t border-border">
                        <td className="px-3 py-1 font-mono">{v.name}</td>
                        <td className="px-3 py-1 font-medium">
                          {v.value || "—"}
                        </td>
                        <td className="px-3 py-1 text-muted-foreground">
                          {v.source || ""}
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
    goBack,
    goNext,
    paperCharacteristics,
    setPaperCharacteristics,
  } = useWorkflow();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!paper) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "paper_context", paperText: paper.text }),
      });
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await res.text();
        throw new Error(
          `Server returned non-JSON response (status ${res.status}). This usually means the request timed out on the server. Please try again with a shorter paper, or contact support if the problem persists.`,
        );
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Trích xuất thất bại");
      const result: PaperCharacteristicsResult = {
        materials: data.materials ?? [],
        oxidants: data.oxidants ?? [],
        micropollutants: data.micropollutants ?? [],
        generalConditions: data.generalConditions ?? [],
        notes: data.notes ?? "",
      };
      setPaperCharacteristics(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
    } finally {
      setLoading(false);
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

  return (
    <StepShell
      step={3}
      total={8}
      title="Materials"
      description="Trích xuất toàn bộ đặc tính vật liệu và hằng số chung từ paper. Kết quả sẽ được dùng làm nguồn dự phòng khi trích xuất giá trị figure."
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
              {paperCharacteristics ? "Quét lại" : "Trích xuất đặc tính paper"}
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

      {paperCharacteristics && (
        <div className="space-y-6">
          <EntitySection
            title="Vật liệu"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.materials}
          />

          <EntitySection
            title="Chất oxy hóa"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.oxidants}
          />

          <EntitySection
            title="Chất ô nhiễm"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.micropollutants}
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
                      <th className="px-3 py-1.5 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paperCharacteristics.generalConditions.map((v, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1 font-mono">{v.name}</td>
                        <td className="px-3 py-1 font-medium">
                          {v.value || "—"}
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
