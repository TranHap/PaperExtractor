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

// Groups consecutive "## "-tagged (large-font) lines from the first page
// into candidate title blocks — a wrapped multi-line title produces several
// heading lines in a row, which need re-joining into one string. Picks the
// LONGEST candidate group, since running headers/journal branding rendered
// in the same large font tend to be short one-liners while the actual title
// is usually the longest such block near the top of the page.
function extractHeadingTitle(text: string): string | undefined {
  const groups: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      current.push(line.slice(3).trim());
    } else if (current.length) {
      groups.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) groups.push(current.join(" "));
  return groups
    .filter((g) => g.length > 15 && g.length < 300)
    .sort((a, b) => b.length - a.length)[0];
}

// Fallback when the page has no usable heading markup (e.g. a scanned PDF
// with uniform font sizes): grabs the first sentence-ish chunk of a
// plausible title length. Much less reliable than extractHeadingTitle since
// it has no way to distinguish the actual title from a running header or
// journal identifier that happens to fall in the same length range.
function extractFirstSentenceTitle(text: string): string | undefined {
  return text
    .split(/[.\n]/)
    .map((s) => s.trim())
    .find((s) => s.length > 15 && s.length < 200);
}

// Some publisher PDF pipelines (Arbortext/iText, common for ACS journals)
// set the embedded metadata Title field to an internal manuscript ID + page
// range (e.g. "es5b05974 1..9") instead of the real paper title. Trusting
// that blindly showed garbage as the "predicted title" — this rejects
// anything that doesn't read like natural-language prose so we fall through
// to guessing from the page text instead.
function looksLikeRealTitle(s: string): boolean {
  const t = s.trim();
  if (t.length < 15) return false;
  if (/^\S+\s+\d+\.\.\d+$/.test(t)) return false; // "es5b05974 1..9"-style
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 3;
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
    if (info?.Title && looksLikeRealTitle(info.Title)) title = info.Title;
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
      // Release the canvas's (GPU-backed) pixel buffer right away instead of
      // waiting for GC. Re-parsing PDFs repeatedly in one long-lived tab
      // (re-uploads, retries) otherwise accumulates canvas memory until the
      // browser starts silently returning null from getContext("2d") — text
      // extraction doesn't use canvas, so that failure was invisible: pages
      // still parsed "successfully" with zero page images, and every step
      // downstream that needs one (Digitize's page picker/auto-pick) was
      // left with nothing to show and no explanation why.
      canvas.width = 0;
      canvas.height = 0;
    } else {
      // Keep pageImages aligned 1:1 with page number even when rendering
      // fails for just this one page — pushing nothing here would shift
      // every later page's image down by one slot, so e.g. page 5's auto-
      // picked "image" would silently actually be page 6's.
      pageImages.push("");
      console.warn(
        `[parsePdf] canvas 2D context unavailable for page ${i}/${total} — page image will be missing. This usually means too many canvases have been created in this tab; reloading the page frees them.`,
      );
    }
    page.cleanup();
  }

  if (!title) {
    const firstPage = fullText.split("[Page 2]")[0] || fullText;
    const stripped = firstPage.replace("[Page 1]", "");
    title = extractHeadingTitle(stripped) ?? extractFirstSentenceTitle(stripped);
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
