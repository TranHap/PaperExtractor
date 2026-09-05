"use client";

import { useEffect, useRef, useState } from "react";
import { ImageUp } from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { FigureDigitizer } from "@/components/figure-digitizer";
import { useWorkflow } from "@/lib/workflow-context";
import { cn } from "@/lib/utils";

// Digitizing pixel points is its own step, separate from Fill Values — the
// two used to be merged onto one page to save a click, but that squeezed
// both into half the screen width each (a fixed-width calibration sidebar
// next to an already-halved image is unusably small on a normal laptop
// screen). Splitting them back out gives each the full page width; they
// remain independent tasks that don't block each other, so doing them on
// separate steps costs nothing besides one extra "Tiếp tục" click.
export function DigitizeStep() {
  const {
    paper,
    schema,
    selectedFigure,
    digitization,
    setDigitization,
    digitizationByFigure,
    setDigitizationByFigure,
    xField,
    setXField,
    yField,
    setYField,
    seriesField,
    setSeriesField,
    goBack,
    goNext,
  } = useWorkflow();
  const uploadRef = useRef<HTMLInputElement>(null);
  const previousFigureId = useRef<string | null>(null);

  const currentFigureId = selectedFigure?.id ?? null;
  const allFields = schema?.fields ?? [];

  // --- Digitization: restore per-figure cache when switching figures ---
  useEffect(() => {
    if (!currentFigureId) return;
    const cached = digitizationByFigure[currentFigureId];
    setDigitization(cached ?? null);
  }, [currentFigureId, digitizationByFigure, setDigitization]);

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

  const canProceed = !!digitization;

  return (
    <StepShell
      stepId="digitize"
      title="Digitize"
      description="Hiệu chỉnh trục X/Y và số hóa dữ liệu từ figure này."
      onBack={goBack}
      onNext={goNext}
      nextDisabled={!canProceed}
    >
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
            extraPanel={
              <details className="group rounded-lg border border-border bg-card">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium marker:hidden">
                  Đặt tên cột X / Y / Series
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                    Mặc định: x / y / series
                  </span>
                </summary>
                <div className="flex flex-col gap-4 border-t border-border p-4">
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
                    <label
                      key={column.label}
                      className="flex flex-col gap-1.5 text-sm"
                    >
                      <span className="font-medium">{column.label}</span>
                      <select
                        value={column.value}
                        onChange={(event) => column.setValue(event.target.value)}
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="">
                          Giữ tên mặc định: {column.fallback}
                        </option>
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
            }
          />
        ) : (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
            <p className="text-sm text-muted-foreground">
              Chọn một trang PDF hoặc tải ảnh figure để bắt đầu số hóa.
            </p>
          </div>
        )}
      </div>
    </StepShell>
  );
}
