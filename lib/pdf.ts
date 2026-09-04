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

  const lines = new Map<number, { x: number; text: string; size: number }[]>();

  for (const it of textItems) {
    const y = Math.round(it.transform[5]);
    const x = it.transform[4];
    const size = Math.abs(it.transform[0]) || 12;
    const key = y;

    if (!lines.has(key)) lines.set(key, []);
    lines.get(key)!.push({ x, text: it.str, size });
  }

  // Sorted top-to-bottom by y. Each entry carries its own y/chars together so
  // there's no risk of a line's text being paired with a different line's y
  // (Map iteration order is insertion order, not sorted order, so re-deriving
  // y by index from `lines.keys()` after sorting would silently mismatch).
  const sortedEntries = Array.from(lines.entries()).sort((a, b) => b[0] - a[0]);

  const result: string[] = [];
  let lastY: number | null = null;
  let lastSize = 12;
  const paragraphGap = 18;

  for (const [y, chars] of sortedEntries) {
    const line = chars
      .sort((a, b) => a.x - b.x)
      .map((c) => c.text)
      .join(" ");
    const trimmed = line.trim();
    if (!trimmed) continue;

    const avgSize = chars.reduce((s, c) => s + c.size, 0) / (chars.length || 1);
    const isHeading = avgSize >= 14 && line.trim().length < 120;

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

/**
 * Combines a main paper with any number of supplementary documents (SI PDFs)
 * into one ParsedPaper. Required characterization values (SBET, pHpzc,
 * oxidant MW, LogKow...) routinely live in SI rather than the main text, so
 * every downstream extraction call needs to see both — this is the only
 * place that needs to know about "supplementary" as a concept; everything
 * downstream just keeps working with a single ParsedPaper/paperText.
 */
export function mergeParsedPapers(
  main: ParsedPaper,
  supplements: ParsedPaper[],
): ParsedPaper {
  if (supplements.length === 0) return main;

  let text = main.text;
  let pages = main.pages;
  const pageTexts = [...main.pageTexts];
  const pageImages = [...main.pageImages];

  for (const sup of supplements) {
    text += `\n\n===== SUPPLEMENTARY INFORMATION (${sup.fileName}) =====\n\n${sup.text}`;
    pages += sup.pages;
    pageTexts.push(...sup.pageTexts);
    pageImages.push(...sup.pageImages);
  }

  return {
    fileName: main.fileName,
    title: main.title,
    text,
    pages,
    pageTexts,
    pageImages,
  };
}
