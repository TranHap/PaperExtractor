"use client";

import { useState } from "react";
import { Loader2, ScanSearch, AlertCircle, Check } from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWorkflow } from "@/lib/workflow-context";
import type { FigureItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FiguresVariablesStep() {
  const {
    paper,
    figures,
    setFigures,
    selectedFigure,
    setSelectedFigure,
    exportedFigureIds,
    goBack,
    goNext,
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
        body: JSON.stringify({ task: "figures", paperText: paper.text }),
      });
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await res.text();
        throw new Error(`Server returned non-JSON response (status ${res.status}). This usually means the request timed out on the server. Please try again with a shorter paper, or contact support if the problem persists.`);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không lập được inventory");
      const items: FigureItem[] = (
        data.figures as Omit<FigureItem, "id">[]
      ).map((f, i) => ({
        ...f,
        id: `fig-${i}`,
      }));
      setFigures(items);
      if (!selectedFigure && items.length > 0) {
        setSelectedFigure(items[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
    } finally {
      setLoading(false);
    }
  }

  return (
    <StepShell
      step={4}
      total={8}
      title="Figures & Variables"
      description="Chọn figure để xử lý."
      onBack={goBack}
      onNext={goNext}
      nextDisabled={!selectedFigure}
      nextLabel="Xác nhận & tiếp tục"
    >
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {figures.length > 0
            ? `Tìm thấy ${figures.length} figure`
            : "Chưa quét figure"}
        </p>
        <Button
          onClick={run}
          disabled={loading}
          variant={figures.length ? "outline" : "default"}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ScanSearch className="size-4" />
          )}
          <span>{figures.length ? "Quét lại" : "Quét figure"}</span>
        </Button>
      </div>

      {error && (
        <p className="mb-4 flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      {figures.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {figures.map((f) => {
            const active = selectedFigure?.id === f.id;
            const exported = exportedFigureIds.includes(f.id);
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelectedFigure(f)}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors",
                  active
                    ? exported
                      ? "border-destructive bg-destructive/5 ring-1 ring-destructive"
                      : "border-primary bg-primary/5 ring-1 ring-primary"
                    : exported
                      ? "border-destructive/60 bg-destructive/5 hover:border-destructive"
                      : "border-border bg-card hover:border-primary/40",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{f.label}</span>
                  <div className="flex items-center gap-1.5">
                    {exported && (
                      <span className="flex items-center gap-1 text-xs font-medium text-destructive">
                        <Check className="size-3.5" /> Đã xuất
                      </span>
                    )}
                    {active && !exported && (
                      <span className="flex items-center gap-1 text-xs font-medium text-primary">
                        <Check className="size-3.5" /> Đã chọn
                      </span>
                    )}
                  </div>
                </div>
                {f.description && (
                  <p className="text-pretty text-sm text-muted-foreground">
                    {f.description}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {f.xAxis && (
                    <Badge variant="secondary" className="text-[10px]">
                      x: {f.xAxis}
                    </Badge>
                  )}
                  {f.yAxis && (
                    <Badge variant="secondary" className="text-[10px]">
                      y: {f.yAxis}
                    </Badge>
                  )}
                  {f.changingVariable && f.changingVariable.length > 0 && (
                    <>
                      {f.changingVariable.map((v) => (
                        <Badge
                          key={v}
                          variant="outline"
                          className="border-primary/40 text-[10px] text-primary"
                        >
                          var: {v}
                        </Badge>
                      ))}
                    </>
                  )}
                </div>
                {f.curveLabels && f.curveLabels.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Curves: {f.curveLabels.join(", ")}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Đang quét figure trong paper..."
              : "Bấm “Quét figure” để lập inventory."}
          </p>
        </div>
      )}
    </StepShell>
  );
}
