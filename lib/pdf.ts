"use client";

import type { ParsedPaper } from "@/lib/workflow-context";

// pdfjs is loaded lazily on the client only.
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

export interface ParseProgress {
  page: number;
  total: number;
  phase: "text" | "render";
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  dir: string;
}

function isTextItem(item: unknown): item is TextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    "transform" in item &&
    Array.isArray((item as { transform: unknown }).transform) &&
    (item as { transform: number[] }).transform.length >= 6
  );
}

function extractStructuredText(items: unknown[]): string {
  const textItems: TextItem[] = items.filter(isTextItem);
  if (textItems.length === 0) return "";

  const pageHeight =
    textItems.reduce(
      (max, it) => Math.max(max, it.transform[5] + it.height),
      0,
    ) || 1;

  const lines = new Map<number, { x: number; text: string; size: number }[]>();

  for (const it of textItems) {
    const y = Math.round(it.transform[5]);
    const x = it.transform[4];
    const size = Math.abs(it.transform[0]) || 12;
    const key = y;

    if (!lines.has(key)) lines.set(key, []);
    lines.get(key)!.push({ x, text: it.str, size });
  }

  const sortedLines = Array.from(lines.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([, chars]) =>
      chars
        .sort((a, b) => a.x - b.x)
        .map((c) => c.text)
        .join(" "),
    );

  const result: string[] = [];
  let lastY: number | null = null;
  let lastSize = 12;
  const paragraphGap = 18;

  for (let i = 0; i < sortedLines.length; i++) {
    const line = sortedLines[i];
    const y = Array.from(lines.keys())[i];
    const sizes = lines.get(y) || [];
    const avgSize = sizes.reduce((s, c) => s + c.size, 0) / (sizes.length || 1);
    const isHeading = avgSize >= 14 && line.trim().length < 120;
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (lastY !== null) {
      const gap = lastY - y;
      if (isHeading || (gap > paragraphGap && lastSize < 14)) {
        result.push("");
      }
    }

    if (isHeading) {
      result.push(`## ${trimmed}`);
    } else {
      result.push(trimmed);
    }

    lastY = y;
    lastSize = avgSize;
  }

  return result.join("\n");
}

export async function parsePdf(
  file: File,
  onProgress?: (p: ParseProgress) => void,
): Promise<ParsedPaper> {
  const pdfjs = await getPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const total = doc.numPages;

  let fullText = "";
  const pageTexts: string[] = [];
  const pageImages: string[] = [];
  let title: string | undefined;

  try {
    const meta = await doc.getMetadata();
    const info = meta?.info as { Title?: string } | undefined;
    if (info?.Title) title = info.Title;
  } catch {
    // ignore metadata errors
  }

  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);

    onProgress?.({ page: i, total, phase: "text" });
    const content = await page.getTextContent();
    const structured = extractStructuredText(content.items);
    pageTexts.push(structured);
    fullText += `\n\n[Page ${i}]\n${structured}`;

    onProgress?.({ page: i, total, phase: "render" });
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (context) {
      await page.render({ canvasContext: context, viewport }).promise;
      pageImages.push(canvas.toDataURL("image/jpeg", 0.85));
    }
    page.cleanup();
  }

  if (!title) {
    const firstPage = fullText.split("[Page 2]")[0] || fullText;
    const candidate = firstPage
      .replace("[Page 1]", "")
      .split(/[.\n]/)
      .map((s) => s.trim())
      .find((s) => s.length > 15 && s.length < 200);
    title = candidate;
  }

  return {
    fileName: file.name,
    title,
    text: fullText.trim(),
    pages: total,
    pageTexts,
    pageImages,
  };
}
