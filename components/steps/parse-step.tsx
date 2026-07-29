"use client";

import { useRef, useState } from "react";
import {
  FileText,
  Loader2,
  Upload,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useWorkflow } from "@/lib/workflow-context";
import { parsePdf, type ParseProgress } from "@/lib/pdf";

export function ParseStep() {
  const { paper, setPaper, goBack, goNext } = useWorkflow();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setLoading(true);
    setProgress(null);
    try {
      const result = await parsePdf(file, (p) => setProgress(p));
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

  const pct = progress ? Math.round((progress.page / progress.total) * 100) : 0;

  return (
    <StepShell
      step={2}
      total={8}
      title="Parse Paper"
      description="Tải lên file PDF của paper. Hệ thống sẽ bóc tách toàn bộ text và render từng trang thành ảnh."
      onBack={goBack}
      onNext={goNext}
      nextDisabled={!paper}
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f && f.type === "application/pdf") handleFile(f);
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
                  <p className="text-sm font-medium">Kéo thả PDF vào đây</p>
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
                    if (f) handleFile(f);
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
                </dd>
                <dt className="text-muted-foreground">Số trang</dt>
                <dd className="text-right font-medium tabular-nums">
                  {paper.pages}
                </dd>
                <dt className="text-muted-foreground">Số ký tự</dt>
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
