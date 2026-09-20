"use client";

import type { ParsedPaper } from "@/lib/workflow-context";

// mammoth is loaded lazily on the client only, same pattern as pdfjs in
// lib/pdf.ts — keeps it out of the initial bundle since only the
// supplementary-upload path needs it. Importing the package's main entry
// (rather than its standalone mammoth.browser.js bundle, meant for non-
// bundler <script> usage) so the bundler applies mammoth's package.json
// "browser" field remaps (unzip.js, docx/files.js) and we keep real types.
let mammothPromise: Promise<typeof import("mammoth")> | null = null;

async function getMammoth() {
  if (!mammothPromise) {
    mammothPromise = import("mammoth");
  }
  return mammothPromise;
}

/**
 * Parses a .docx Supplementary Information file into the same ParsedPaper
 * shape parsePdf produces, so mergeParsedPapers (lib/pdf.ts) and every
 * downstream extraction step can treat it identically to a PDF SI.
 *
 * A .docx has no fixed page layout the way a PDF does, so this is modeled as
 * ONE page of text with no page image — Digitize's page picker (which reads
 * paper.pageImages) simply has nothing to offer for it, which is correct:
 * there's no page image to digitize a figure from in a Word doc, only text
 * for the text-extraction steps (Materials, Fill Values) to read.
 */
export async function parseDocx(file: File): Promise<ParsedPaper> {
  const mammoth = await getMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const { value: text } = await mammoth.extractRawText({ arrayBuffer });
  const trimmed = text.trim();

  return {
    fileName: file.name,
    title: undefined,
    text: trimmed,
    pages: 1,
    pageTexts: [trimmed],
    // Kept 1:1 aligned with pageTexts (see the "" placeholder convention in
    // parsePdf for a failed page render) — an empty string, not a missing
    // index, so any code indexing pageImages by the same index as pageTexts
    // degrades gracefully instead of reading past the array.
    pageImages: [""],
  };
}

const DOCX_EXTENSIONS = [".docx"];
const DOCX_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export function isDocxFile(file: File): boolean {
  if (DOCX_MIME_TYPES.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return DOCX_EXTENSIONS.some((ext) => name.endsWith(ext));
}
