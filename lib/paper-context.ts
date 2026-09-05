import type {
  FieldValue,
  PaperCharacteristicEntity,
  PaperCharacteristicMaterial,
} from "@/lib/types";

// Shared between the client (paper-characteristics-step.tsx, which now
// drives the paper_context scan chunk-by-chunk itself) and the server
// (app/api/extract/route.ts, which scans one chunk per request). Netlify's
// Next.js Server Handler enforces a hard ~30s synchronous timeout regardless
// of the route's declared `runtime`/`maxDuration` — a single request that
// tries to scan every chunk of a paper server-side routinely exceeds that,
// so the client now fires one small request per chunk (each finishes in a
// few seconds) and merges the results itself using the same logic that used
// to run entirely on the server.

export const PAPER_CONTEXT_CHUNK_SIZE = 7000;
export const PAPER_CONTEXT_CHUNK_OVERLAP = 500;
export const PAPER_CONTEXT_MAX_TOTAL_CHARS = 200_000;
export const PAPER_CONTEXT_MAX_CONCURRENT_CHUNKS = 6;

export type EntityNames = {
  materials: { name: string; role?: string }[];
  oxidants: { name: string }[];
  micropollutants: { name: string }[];
};

export type PaperContextChunkResult = {
  materials: PaperCharacteristicMaterial[];
  oxidants: PaperCharacteristicEntity[];
  micropollutants: PaperCharacteristicEntity[];
  generalConditions: FieldValue[];
  notes?: string;
};

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n[...truncated...]";
}

// Splits text into overlapping chunks, preferring to break at a paragraph or
// sentence boundary near the target size so a caption/table isn't sliced
// exactly in half between two chunks. The overlap means content that falls
// right on a boundary still shows up whole in at least one chunk.
export function chunkText(
  text: string,
  chunkSize: number,
  overlap: number,
): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const searchFrom = Math.max(start, end - 400);
      const lookback = text.slice(searchFrom, end);
      const lastBreak = Math.max(
        lookback.lastIndexOf("\n\n"),
        lookback.lastIndexOf(". "),
      );
      if (lastBreak > -1) {
        end = searchFrom + lastBreak + 1;
      }
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

// Runs `fn` over `items` with at most `concurrency` calls in flight at once.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function keysLikelyMatch(a: string, b: string): boolean {
  const na = normKey(a);
  const nb = normKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na)))
    return true;
  return false;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

// Looser than keysLikelyMatch's contiguous-substring check — needed because
// the same entity can get a full descriptive name in one chunk (e.g.
// "CuFeO2 rhombohedral crystals (RCs)") and just its short form in another
// ("CuFeO2 RCs"), and the extra words in between break substring matching
// even though every meaningful word of the short form is present in the
// long form. Matches when every token of the shorter name appears somewhere
// in the longer name's token set.
export function namesLikelyMatch(a: string, b: string): boolean {
  if (keysLikelyMatch(a, b)) return true;
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) {
    if (!big.has(t)) return false;
  }
  return true;
}

// Merges two arrays of field-values keyed by (normalized) field name: keeps
// the first non-empty value seen for each name, only falling back to a
// later chunk's answer when the earlier one was empty/not_reported.
export function mergeFieldValueArrays(
  existing: FieldValue[],
  incoming: FieldValue[],
): FieldValue[] {
  const merged = [...existing];
  const indexByKey = new Map<string, number>();
  merged.forEach((v, i) => indexByKey.set(normKey(v.name), i));
  for (const v of incoming) {
    const key = normKey(v.name);
    const idx = indexByKey.get(key);
    if (idx === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(v);
      continue;
    }
    if (!merged[idx].value?.trim() && v.value?.trim()) {
      merged[idx] = v;
    }
  }
  return merged;
}

// Merges entity lists (materials/oxidants/micropollutants) across chunks:
// same entity named slightly differently in two chunks (per namesLikelyMatch)
// collapses into one entry, with its values merged via mergeFieldValueArrays,
// 'role' kept from whichever chunk set it first, and the longer/more
// descriptive of the two names kept as the display name (chunk order is
// non-deterministic under concurrency, so we can't just keep "whichever
// came first").
export function mergeEntityLists<
  T extends { name: string; role?: string; values: FieldValue[] },
>(all: T[]): T[] {
  const order: string[] = [];
  const byKey = new Map<string, T>();
  for (const e of all) {
    if (!e?.name?.trim()) continue;
    const matchedKey = order.find((k) => namesLikelyMatch(k, e.name));
    if (!matchedKey) {
      order.push(e.name);
      byKey.set(e.name, { ...e, values: [...(e.values ?? [])] });
      continue;
    }
    const existing = byKey.get(matchedKey)!;
    byKey.set(matchedKey, {
      ...existing,
      name: e.name.length > existing.name.length ? e.name : existing.name,
      role: existing.role || e.role,
      values: mergeFieldValueArrays(existing.values, e.values ?? []),
    });
  }
  return order.map((k) => byKey.get(k)!);
}

export function knownEntitiesToPromptBlock(knownEntities: EntityNames): string {
  return [
    knownEntities.materials.length > 0
      ? `Materials: ${knownEntities.materials.map((m) => `"${m.name}"${m.role ? ` (${m.role})` : ""}`).join(", ")}`
      : "Materials: (none identified)",
    knownEntities.oxidants.length > 0
      ? `Oxidants: ${knownEntities.oxidants.map((o) => `"${o.name}"`).join(", ")}`
      : "Oxidants: (none identified)",
    knownEntities.micropollutants.length > 0
      ? `Micropollutants: ${knownEntities.micropollutants.map((m) => `"${m.name}"`).join(", ")}`
      : "Micropollutants: (none identified)",
  ].join("\n");
}
