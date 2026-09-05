"use client";

import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Loader2,
  Upload,
  CheckCircle2,
  AlertCircle,
  FilePlus2,
  X,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useWorkflow } from "@/lib/workflow-context";
import type { ParsedPaper } from "@/lib/workflow-context";
import { parsePdf, mergeParsedPapers, type ParseProgress } from "@/lib/pdf";

export function ParseStep() {
  const { paper, setPaper, goNext } = useWorkflow();
  const [mainPaper, setMainPaper] = useState<ParsedPaper | null>(null);
  const [supplements, setSupplements] = useState<ParsedPaper[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [supLoading, setSupLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const supInputRef = useRef<HTMLInputElement>(null);

  // If the app reloaded from persisted state, `paper` already holds a merged
  // result from a previous session but we don't have its pure "main paper"
  // (pre-supplement) text separately anymore. Snapshot it once so that any
  // supplement added THIS session merges on top of it correctly instead of
  // re-merging into an already-merged blob.
  useEffect(() => {
    if (!mainPaper && paper) setMainPaper(paper);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleMainFile(file: File) {
    setError(null);
    setLoading(true);
    setProgress(null);
    try {
      const result = await parsePdf(file, (p) => setProgress(p));
      setMainPaper(result);
      setSupplements([]);
      setPaper(result);
    } catch (e) {
      console.log(
        "[v0] pdf parse error:",
        e instanceof Error ? e.message : String(e),
      );
      setError(
        "Không đọc được PDF. Hãy thử file khác hoặc kiểm tra file có bị mã hóa không.",
      );
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  async function handleSupplementFiles(files: File[]) {
    const base = mainPaper ?? paper;
    if (!base || files.length === 0) return;
    setError(null);
    setSupLoading(true);
    try {
      const parsed: ParsedPaper[] = [];
      for (const file of files) {
        parsed.push(await parsePdf(file));
      }
      const next = [...supplements, ...parsed];
      setSupplements(next);
      setPaper(mergeParsedPapers(base, next));
    } catch (e) {
      console.log(
        "[v0] supplementary pdf parse error:",
        e instanceof Error ? e.message : String(e),
      );
      setError(
        "Không đọc được một trong các file bổ sung. Hãy thử file khác hoặc kiểm tra file có bị mã hóa không.",
      );
    } finally {
      setSupLoading(false);
    }
  }

  function removeSupplement(index: number) {
    const base = mainPaper ?? paper;
    if (!base) return;
    const next = supplements.filter((_, i) => i !== index);
    setSupplements(next);
    setPaper(mergeParsedPapers(base, next));
  }

  const pct = progress ? Math.round((progress.page / progress.total) * 100) : 0;

  return (
    <StepShell
      stepId="parse"
      title="Upload Paper"
      description="Tải lên file PDF của paper chính, và (tùy chọn) mọi tài liệu bổ sung (Supplementary Information). Hệ thống sẽ bóc tách toàn bộ text và render từng trang thành ảnh — các bước trích xuất sau đó sẽ đọc cả hai."
      hideBack
      onNext={goNext}
      nextDisabled={!paper}
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-5">
          <div>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f && f.type === "application/pdf") handleMainFile(f);
              }}
              className="flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-card p-8 text-center"
            >
              {loading ? (
                <>
                  <Loader2 className="size-8 animate-spin text-primary" />
                  <p className="text-sm font-medium">
                    {progress?.phase === "render"
                      ? "Đang render trang"
                      : "Đang bóc tách text"}{" "}
                    {progress?.page}/{progress?.total}
                  </p>
                  <Progress value={pct} className="w-64" />
                </>
              ) : (
                <>
                  <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                    <Upload className="size-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      Kéo thả PDF paper chính vào đây
                    </p>
                    <p className="text-xs text-muted-foreground">
                      hoặc bấm nút bên dưới để chọn file
                    </p>
                  </div>
                  <Button onClick={() => inputRef.current?.click()}>
                    <FileText className="size-4" />
                    Chọn file PDF
                  </Button>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleMainFile(f);
                    }}
                  />
                </>
              )}
            </div>
            {error && (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
                <AlertCircle className="size-4" />
                {error}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">
                  Tài liệu bổ sung (Supplementary Information)
                </h2>
                <p className="text-xs text-muted-foreground">
                  Tùy chọn — nhiều đặc tính (SBET, pHpzc, MW oxidant,
                  LogKow...) thường chỉ nằm trong SI, không nằm trong bài
                  chính.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!paper || supLoading}
                onClick={() => supInputRef.current?.click()}
              >
                {supLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FilePlus2 className="size-3.5" />
                )}
                Thêm file SI
              </Button>
              <input
                ref={supInputRef}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="sr-only"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) handleSupplementFiles(files);
                  e.target.value = "";
                }}
              />
            </div>
            {!paper ? (
              <p className="text-xs text-muted-foreground">
                Tải paper chính trước để thêm tài liệu bổ sung.
              </p>
            ) : supplements.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Chưa có tài liệu bổ sung nào.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {supplements.map((s, i) => (
                  <li
                    key={`${s.fileName}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
                  >
                    <span className="truncate">
                      {s.fileName}{" "}
                      <span className="text-xs text-muted-foreground">
                        ({s.pages} trang)
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeSupplement(i)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Xóa ${s.fileName}`}
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <aside className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-medium">Kết quả bóc tách</h2>
          {paper ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-primary">
                <CheckCircle2 className="size-4" />
                <span className="font-medium">Đã xử lý xong</span>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted-foreground">File</dt>
                <dd className="truncate text-right font-medium">
                  {paper.fileName}
                  {supplements.length > 0 && ` +${supplements.length} SI`}
                </dd>
                <dt className="text-muted-foreground">Tổng số trang</dt>
                <dd className="text-right font-medium tabular-nums">
                  {paper.pages}
                </dd>
                <dt className="text-muted-foreground">Tổng số ký tự</dt>
                <dd className="text-right font-medium tabular-nums">
                  {paper.text.length.toLocaleString()}
                </dd>
              </dl>
              {paper.title && (
                <div>
                  <p className="text-xs text-muted-foreground">
                    Tiêu đề (dự đoán)
                  </p>
                  <p className="text-pretty text-sm">{paper.title}</p>
                </div>
              )}
              {paper.pageImages[0] && (
                <img
                  src={paper.pageImages[0] || "/placeholder.svg"}
                  alt="Xem trước trang đầu tiên của PDF"
                  className="w-full rounded-md border border-border"
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Chưa có file nào được xử lý.
            </p>
          )}
        </aside>
      </div>
    </StepShell>
  );
}
