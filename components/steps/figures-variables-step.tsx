"use client";

import { useState } from "react";
import { Loader2, ScanSearch, AlertCircle, Check, Plus } from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
    digitizationByFigure,
    goBack,
    goNext,
  } = useWorkflow();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualLabel, setManualLabel] = useState("");

  // Manual fallback for when the AI scan is unavailable (server/model down)
  // or simply missed a figure — without this, a failed "figures" call left
  // `figures` empty with no way to ever get a `selectedFigure`, and every
  // later step (Digitize included) silently depends on that id to persist
  // anything. Typing a label and adding it here guarantees the same id shape
  // (`fig-N`) the AI path produces, so nothing downstream needs to know the
  // figure was added by hand instead of scanned.
  function addManualFigure() {
    const label = manualLabel.trim();
    if (!label) return;
    const id = `fig-manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const item: FigureItem = { id, label };
    const next = [...figures, item];
    setFigures(next);
    setSelectedFigure(item);
    setManualLabel("");
  }

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
      stepId="figures-variables"
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

      <div className="mb-5 flex items-center gap-2 rounded-lg border border-dashed border-border p-3">
        <Input
          value={manualLabel}
          onChange={(e) => setManualLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addManualFigure();
            }
          }}
          placeholder="Thêm figure thủ công, vd. Figure 3b"
          aria-label="Tên figure thêm thủ công"
          className="max-w-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addManualFigure}
          disabled={!manualLabel.trim()}
        >
          <Plus className="size-4" />
          Thêm
        </Button>
        <span className="text-xs text-muted-foreground">
          Dùng khi AI lỗi/không quét được, hoặc bỏ sót figure
        </span>
      </div>

      {figures.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {figures.map((f) => {
            const active = selectedFigure?.id === f.id;
            const digitized = (digitizationByFigure[f.id]?.points.length ?? 0) > 0;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelectedFigure(f)}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : digitized
                      ? "border-chart-2/60 bg-chart-2/5 hover:border-chart-2"
                      : "border-border bg-card hover:border-primary/40",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{f.label}</span>
                  <div className="flex items-center gap-1.5">
                    {digitized && (
                      <span className="flex items-center gap-1 text-xs font-medium text-chart-2">
                        <Check className="size-3.5" /> Đã số hóa
                      </span>
                    )}
                    {active && !digitized && (
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
