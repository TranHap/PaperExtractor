export interface PaperSection {
  name: string;
  text: string;
  startPage: number;
  endPage: number;
}

export interface FigureCandidate {
  label: string;
  caption: string;
  description?: string;
  pageIndex: number;
}

export interface ExtractedCondition {
  key: string;
  value: string;
}

export interface SuggestedValue {
  fieldName: string;
  value: string;
  reason: string;
}

export function matchConditionsToFields(
  conditions: ExtractedCondition[],
  missingFields: { name: string; description?: string; unit?: string }[],
): SuggestedValue[] {
  const suggestions: SuggestedValue[] = [];
  const used = new Set<string>();

  for (const condition of conditions) {
    const key = condition.key.toLowerCase().replace(/[()]/g, "").trim();
    const value = condition.value.trim();

    let bestMatch: { name: string; score: number } | null = null;

    for (const field of missingFields) {
      if (used.has(field.name)) continue;
      const fieldText = [field.name, field.description ?? "", field.unit ?? ""]
        .join(" ")
        .toLowerCase();

      let score = 0;

      if (
        fieldText.includes(key) ||
        key.includes(field.name.toLowerCase().replace(/[()]/g, ""))
      ) {
        score += 3;
      }

      if (
        field.description &&
        key.includes(field.description.toLowerCase().split(" ")[0])
      ) {
        score += 2;
      }

      if (field.unit && value.includes(field.unit)) {
        score += 1;
      }

      if (bestMatch && score > bestMatch.score) {
        bestMatch = { name: field.name, score };
      } else if (!bestMatch && score > 0) {
        bestMatch = { name: field.name, score };
      }
    }

    if (bestMatch) {
      suggestions.push({
        fieldName: bestMatch.name,
        value,
        reason: `Matched from extracted condition: ${condition.key} = ${value}`,
      });
      used.add(bestMatch.name);
    }
  }

  return suggestions;
}

export function extractConditionsFromText(text: string): ExtractedCondition[] {
  const conditions: ExtractedCondition[] = [];
  const seen = new Set<string>();

  const patterns = [
    /\b([A-Za-z][A-Za-z0-9_()\-]*?)\s*[=:]\s*([^\s,;]+(?:\s*[±×x×]\s*[^\s,;]+)?(?:\s*[°º%mMµμgLkMS])?)/g,
    /\b([A-Za-z][A-Za-z0-9_()\-]*?)\s+([0-9]+(?:\.\d+)?)\s*([°º%mMµμgLkMS])?/g,
  ];

  const lines = text.split(/[\n\r]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(trimmed)) !== null) {
        const key = m[1].trim();
        const value = m[2] ? `${m[2]}${m[3] || ""}`.trim() : m[0].trim();

        if (!key || key.length < 2) continue;
        if (
          /^(and|the|in|of|for|with|by|on|at|to|from|is|are|was|were|be|been)$/i.test(
            key,
          )
        )
          continue;
        if (/^(Figure|Fig|Table|Eq|Equation|Ref|Reference)$/i.test(key))
          continue;
        if (/^\d+$/.test(key)) continue;

        const normalizedKey = key.toLowerCase().replace(/[()]/g, "").trim();
        const normalizedValue = value.toLowerCase().trim();

        if (seen.has(`${normalizedKey}:${normalizedValue}`)) continue;
        seen.add(`${normalizedKey}:${normalizedValue}`);

        if (normalizedValue.length > 0 && normalizedValue.length < 100) {
          conditions.push({ key, value });
        }
      }
    }
  }

  return conditions.slice(0, 40);
}

const SECTION_HEADERS = [
  "RESULTS AND DISCUSSION",
  "METHODS AND MATERIALS",
  "EXPERIMENTAL SECTION",
  "SUPPORTING INFORMATION",
  "ACKNOWLEDGMENTS",
  "ACKNOWLEDGEMENTS",
  "LITERATURE REVIEW",
  "ABSTRACT",
  "BACKGROUND",
  "METHODS",
  "MATERIALS",
  "EXPERIMENTAL",
  "RESULTS",
  "DISCUSSION",
  "FINDINGS",
  "CONCLUSION",
  "CONCLUSIONS",
  "REFERENCES",
  "SUPPLEMENTARY",
];

const HEADER_PATTERN = new RegExp(
  `^\\s*(?:\\[Page\\s*\\d+\\]\\s*)?(?:(?:${SECTION_HEADERS.join("|")})\\s*[:.\\-]?\\s*|(?:${SECTION_HEADERS.join("|")})\\s*$)(?:\\s*\\n)+`,
  "gim",
);

const CAPTION_PATTERN =
  /(?:Figure|Fig\.)\s*(\d+\s*[a-z]?)\s*[\):\s.]?\s*([^\n]+(?:\n(?!\s*(?:Figure|Fig\.)\s*\d)[^\n]*)?)/gi;

export function parsePaperSections(fullText: string): PaperSection[] {
  const text = fullText.trim();
  if (!text) return [];

  const matches = Array.from(text.matchAll(HEADER_PATTERN));

  if (matches.length === 0) {
    return [
      {
        name: "FULL TEXT",
        text,
        startPage: 1,
        endPage: countPages(text),
      },
    ];
  }

  const sections: PaperSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const name = m[0].replace(/[:\-]/g, "").trim();
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const sectionText = text.slice(start, end).trim();
    if (!sectionText) continue;

    const pageRange = extractPageRange(
      text.slice(Math.max(0, m.index - 50), start),
    );
    sections.push({
      name: name.toUpperCase(),
      text: sectionText,
      startPage: pageRange[0],
      endPage: pageRange[1],
    });
  }

  return sections;
}

export function extractFigureCandidates(fullText: string): FigureCandidate[] {
  const candidates: FigureCandidate[] = [];
  let match;
  const seen = new Set<string>();

  while ((match = CAPTION_PATTERN.exec(fullText)) !== null) {
    const rawLabel = match[1].replace(/\s+/g, "").trim();
    const label = `Figure ${rawLabel}`;
    const caption = match[2].trim();
    const key = `${label}:${caption}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const pageIndex = findPageForIndex(fullText, match.index);
    candidates.push({
      label,
      caption,
      description: caption,
      pageIndex,
    });
  }

  return candidates;
}

export function getTextForTask(
  task: string,
  fullText: string,
  maxChars = 40000,
  focusLabel?: string,
): string {
  const sections = parsePaperSections(fullText);
  const selected: string[] = [];

  const add = (name: string) => {
    const s = sections.find((x) => x.name === name);
    if (s && s.text) selected.push(s.text);
  };

  switch (task) {
    case "experiment":
      add("METHODS");
      add("MATERIALS");
      add("METHODS AND MATERIALS");
      add("EXPERIMENTAL");
      if (selected.length === 0) selected.push(sections[0]?.text ?? "");
      break;

    case "figures": {
      const figureCandidates = extractFigureCandidates(fullText);
      const figureTexts = figureCandidates.map(
        (f) => `[${f.label}] ${f.caption}`,
      );
      selected.push(...figureTexts);
      add("RESULTS");
      add("DISCUSSION");
      add("CONCLUSION");
      add("CONCLUSIONS");
      if (selected.length === 0) selected.push(sections[0]?.text ?? "");
      break;
    }

    case "resolve":
    case "figure_extract":
    default: {
      if (focusLabel) {
        const figureCandidates = extractFigureCandidates(fullText);
        const normalizedFocus = focusLabel.replace(/\s+/g, "").toLowerCase();
        const focused = figureCandidates.find((f) => {
          const normalizedCandidate = f.label.replace(/\s+/g, "").toLowerCase();
          return normalizedCandidate === normalizedFocus;
        });
        let usedLabel = focused?.label;
        let usedCaption = focused?.caption;
        if (focused) {
          const parentKey = normalizedFocus.replace(/[a-z]+$/i, "");
          const parentMatch = figureCandidates.find((f) => {
            const normalizedCandidate = f.label
              .replace(/\s+/g, "")
              .toLowerCase();
            return normalizedCandidate === parentKey;
          });
          if (
            parentMatch &&
            parentMatch.caption.length > focused.caption.length + 40
          ) {
            usedLabel = parentMatch.label;
            usedCaption = parentMatch.caption;
          }
        }
        if (!focused) {
          const parentKey = normalizedFocus.replace(/[a-z]+$/i, "");
          const parentMatch = figureCandidates.find((f) => {
            const normalizedCandidate = f.label
              .replace(/\s+/g, "")
              .toLowerCase();
            return normalizedCandidate === parentKey;
          });
          if (parentMatch) {
            usedLabel = parentMatch.label;
            usedCaption = parentMatch.caption;
          }
        }
        if (usedLabel && usedCaption) {
          const displayLabel = focused?.label || usedLabel;
          selected.push(`[${displayLabel}] ${usedCaption}`);
        }
      }
      add("METHODS");
      add("MATERIALS");
      add("METHODS AND MATERIALS");
      add("EXPERIMENTAL");
      add("EXPERIMENTAL SECTION");
      if (selected.length === 0) selected.push(sections[0]?.text ?? "");
      break;
    }
  }

  const combined = selected.join("\n\n").trim();
  if (combined.length <= maxChars) return combined;
  return combined.slice(0, maxChars) + "\n\n[...truncated...]";
}

function countPages(text: string): number {
  const matches = text.match(/\[Page\s*\d+\]/gi);
  if (!matches) return 1;
  const nums = matches.map((m) => parseInt(m.replace(/\D/g, ""), 10));
  return Math.max(...nums);
}

function extractPageRange(snippet: string): [number, number] {
  const matches = snippet.match(/\[Page\s*(\d+)\]/gi);
  if (!matches || matches.length === 0) return [1, 1];
  const nums = matches.map((m) => parseInt(m.replace(/\D/g, ""), 10));
  return [Math.min(...nums), Math.max(...nums)];
}

function findPageForIndex(fullText: string, index: number): number {
  const before = fullText.slice(0, index);
  const matches = before.match(/\[Page\s*(\d+)\]/gi);
  if (!matches || matches.length === 0) return 0;
  const last = matches[matches.length - 1];
  return parseInt(last.replace(/\D/g, ""), 10) - 1;
}
