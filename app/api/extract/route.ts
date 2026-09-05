import { streamText, Output } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

// This app is deployed on Netlify. Netlify's regular (Node.js) Functions
// have a short execution ceiling (~10-26s depending on plan) — nowhere near
// enough for the LLM calls this route makes — while Netlify EDGE Functions
// tolerate roughly 40s in practice before the platform kills the invocation
// outright (undocumented exact number, empirically observed: the browser
// gets a raw non-JSON 502 instead of our own JSON error once exceeded). So
// this route intentionally stays on the edge runtime; `maxDuration` below is
// a Vercel-specific route config and is a harmless no-op on Netlify, kept
// only in case this ever moves there.
export const runtime = "edge";
export const maxDuration = 60;

const openaiProvider = createOpenAI();
const MODEL = openaiProvider.chat("gpt-4.1-mini");

// Self-imposed abort budget for a single request. Kept a few seconds under
// Netlify's real ~40s Edge Function cutoff (see comment above) so we can
// still return a clean JSON error instead of letting the platform kill the
// function mid-response and hand the browser a raw timeout page.
const EDGE_BUDGET_MS = 34_000;

class DeadlineExceededError extends Error {
  constructor(
    msg = "Yêu cầu mất quá lâu để xử lý (vượt giới hạn thời gian của server), thử lại giúp mình.",
  ) {
    super(msg);
    this.name = "DeadlineExceededError";
  }
}

async function retryStreamObject(
  args: any,
  retries = 2,
  deadline: number = Date.now() + EDGE_BUDGET_MS,
): Promise<{ object: unknown }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline - Date.now();
    // Don't start another attempt we have no realistic chance of finishing —
    // failing fast here with clean JSON beats letting the platform's own
    // hard timeout hand the browser a raw HTML 502/504 instead.
    if (remaining < 4000) {
      throw lastError ?? new DeadlineExceededError();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const result = streamText({
        // Deterministic extraction, not creative writing: every task here is
        // "read the text and report what's there," so we want the model's
        // top-probability answer every time, not sampled variety. Without
        // this, re-running the SAME extraction on the SAME paper can find a
        // value one run and miss it the next, purely from sampling noise —
        // easy to mistake for a prompt bug when it's actually just
        // temperature. `...args` after it lets a specific call override.
        temperature: 0,
        ...args,
        model: MODEL,
        abortSignal: controller.signal,
      });

      const object = await result.output;
      const usage = await result.usage;
      clearTimeout(timer);
      const cachedTokens = usage?.inputTokenDetails?.cacheReadTokens;
      if (typeof cachedTokens === "number") {
        console.log("[openai cache]", {
          cachedTokens,
          promptTokens: usage?.inputTokens,
        });
      }

      return { object: object as unknown };
    } catch (err) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      lastError = aborted
        ? new DeadlineExceededError()
        : err instanceof Error
          ? err
          : new Error(String(err));

      if (aborted) break; // budget's gone - no point trying again
      const timeLeft = deadline - Date.now();
      if (attempt < retries && timeLeft > 2000) {
        await new Promise((r) =>
          setTimeout(r, Math.min(1000 * (attempt + 1), timeLeft - 1000)),
        );
      }
    }
  }
  throw lastError ?? new Error("Extraction failed after retries");
}

const fieldValueSchema = z.object({
  name: z.string().describe("The exact field name from the schema"),
  value: z
    .string()
    .describe(
      "Standardized value as a string (converted to the field's declared unit if one is given), or empty string if not found. For an identity/category field that genuinely doesn't apply to this system, use 'None / Not applicable' instead of empty.",
    ),
  confidence: z.number().min(0).max(1).describe("Confidence 0-1"),
  source: z
    .string()
    .describe("Short quote or location supporting the value, or empty string"),
  provenance: z
    .enum(["reported", "looked_up", "derived", "not_applicable", "not_reported"])
    .describe(
      "reported = stated explicitly in the paper; looked_up = not stated in the paper, filled from general chemistry knowledge (ONLY for universal physicochemical constants, never for the paper's own measured/experimental data); derived = computed from a reported/looked_up value (e.g. unit conversion); not_applicable = the concept genuinely doesn't apply to this system; not_reported = could not be established.",
    ),
  originalValue: z
    .string()
    .describe(
      "Value + unit exactly as stated in the paper, ONLY set when 'value' is a converted/standardized form of it. Empty string otherwise.",
    ),
  conversionNote: z
    .string()
    .describe(
      "How 'value' was obtained: formula used, exact chemical species and its MW, or the basis for a looked-up constant. Empty string when not applicable.",
    ),
});

function clip(text: string, max = 90000) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n[...truncated...]";
}

// --- Helpers for splitting the "figures" scan into smaller per-section calls ---
//
// Splitting a long paper into chunks and scanning each chunk separately (in
// parallel) keeps every individual model call small on BOTH input and output,
// so each one reliably finishes in a few seconds — instead of one giant call
// that has to describe every figure/panel of an entire paper and can easily
// run past the platform's own hard timeout for papers with many figures.

// Splits text into overlapping chunks, preferring to break at a paragraph or
// sentence boundary near the target size so a figure caption isn't sliced
// exactly in half between two chunks. The overlap means a caption that falls
// right on a boundary still shows up whole in at least one chunk.
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
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
// Network-bound calls like these don't cost meaningful CPU time while waiting
// on a response, so running several in parallel is what actually keeps the
// TOTAL wall-clock time low regardless of how many chunks a paper produces.
async function mapWithConcurrency<T, R>(
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

type RawFigure = {
  label: string;
  caption: string;
  description: string;
  xAxis: string;
  yAxis: string;
  sweepVariable: string;
  curveLabels: string[];
};

function normalizeFigureLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/fig(ure)?s?\.?/g, "figure")
    .replace(/[^a-z0-9]/g, "");
}

// Rough "how complete is this extraction" score, used to pick the better of
// two duplicate sightings of the same figure across overlapping/adjacent
// chunks (e.g. the intro mentions "Figure 3 shows X" while the results
// section has the figure's real caption + axes).
function scoreFigure(f: RawFigure): number {
  return (
    (f.caption?.trim().length ?? 0) +
    (f.description?.trim().length ?? 0) +
    (f.xAxis?.trim() ? 10 : 0) +
    (f.yAxis?.trim() ? 10 : 0) +
    (f.sweepVariable?.trim() ? 10 : 0) +
    (f.curveLabels?.length ?? 0) * 5
  );
}

function parseLabelForSort(label: string): { num: number; panel: string } {
  const m = label.match(/(\d+)\s*([a-z]?)/i);
  return m
    ? { num: parseInt(m[1], 10), panel: (m[2] || "").toLowerCase() }
    : { num: Number.MAX_SAFE_INTEGER, panel: label.toLowerCase() };
}

// Merges figures found across chunks: same figure mentioned in two
// overlapping/nearby chunks gets collapsed into one entry (keeping whichever
// version is more complete, and the union of curveLabels), then sorted back
// into a natural reading order (Figure 2 before Figure 10, panels a < b < c).
function mergeFigures(all: RawFigure[]): RawFigure[] {
  const byKey = new Map<string, RawFigure>();
  const order: string[] = [];
  for (const f of all) {
    if (!f?.label?.trim()) continue;
    const key = normalizeFigureLabel(f.label);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, f);
      order.push(key);
      continue;
    }
    const merged =
      scoreFigure(f) > scoreFigure(existing) ? { ...f } : { ...existing };
    merged.curveLabels = Array.from(
      new Set([...(existing.curveLabels ?? []), ...(f.curveLabels ?? [])]),
    );
    byKey.set(key, merged);
  }
  return order
    .map((key) => byKey.get(key)!)
    .sort((a, b) => {
      const pa = parseLabelForSort(a.label);
      const pb = parseLabelForSort(b.label);
      return pa.num !== pb.num
        ? pa.num - pb.num
        : pa.panel.localeCompare(pb.panel);
    });
}

// --- Deterministic fallback fill for "figure_extract" ---
//
// The figure-level LLM call already has a "look up in paper_context" rule
// baked into its prompt (rule 10), but that's a soft instruction — the model
// can still leave a field empty even when paper_context clearly has a
// matching value, e.g. by failing to recognize the field name refers to a
// property it already extracted. This is a small, deterministic safety net
// applied AFTER the LLM call: for any field the model left empty, try to
// match it by name against paper_context and fill it in directly, instead of
// silently trusting the LLM's judgment call alone (see
// app/api/extract/fill_value_issue.md, improvement #3).

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function keysLikelyMatch(a: string, b: string): boolean {
  const na = normKey(a);
  const nb = normKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na)))
    return true;
  return false;
}

type LooseFieldValue = {
  name: string;
  value: string;
  confidence?: number;
  source?: string;
  provenance?: string;
  originalValue?: string;
  conversionNote?: string;
};

type PaperContextShape = {
  materials?: unknown[];
  oxidants?: unknown[];
  micropollutants?: unknown[];
  generalConditions?: unknown[];
};

// Builds (fieldNameCandidate -> sourceValue) pairs from paper_context.
// Entity-scoped properties (materials/oxidants/micropollutants) are only
// offered as candidates when there's EXACTLY ONE entity of that kind in the
// paper — with more than one entity, a bare field name like "SBET" doesn't
// tell us which entity it belongs to, and guessing the wrong one is worse
// than leaving the field empty for the user to resolve manually.
function buildFallbackCandidates(
  paperContext: PaperContextShape | undefined,
): { key: string; value: LooseFieldValue }[] {
  if (!paperContext) return [];
  const out: { key: string; value: LooseFieldValue }[] = [];

  const addSingleEntityGroup = (entities: unknown[] | undefined) => {
    if (!entities || entities.length !== 1) return;
    const entity = entities[0] as { values?: LooseFieldValue[] };
    for (const v of entity.values ?? []) {
      if (v?.value?.trim()) out.push({ key: v.name, value: v });
    }
  };
  addSingleEntityGroup(paperContext.materials);
  addSingleEntityGroup(paperContext.oxidants);
  addSingleEntityGroup(paperContext.micropollutants);

  for (const v of (paperContext.generalConditions ??
    []) as LooseFieldValue[]) {
    if (v?.value?.trim()) out.push({ key: v.name, value: v });
  }
  return out;
}

function applyFallbackFill(
  values: LooseFieldValue[],
  fields: { name: string; description?: string }[],
  changingFieldNames: Set<string>,
  candidates: { key: string; value: LooseFieldValue }[],
): { values: LooseFieldValue[]; filledCount: number } {
  if (candidates.length === 0) return { values, filledCount: 0 };
  let filledCount = 0;
  const next = values.map((v) => {
    if (v.value?.trim()) return v;
    if (changingFieldNames.has(v.name)) return v;
    const field = fields.find((f) => f.name === v.name);
    const match = candidates.find(
      (c) =>
        keysLikelyMatch(c.key, v.name) ||
        (field?.description && keysLikelyMatch(c.key, field.description)),
    );
    if (!match) return v;
    filledCount++;
    return {
      ...v,
      value: match.value.value,
      confidence: match.value.confidence ?? 0.5,
      source: `Paper context (auto-fill fallback): ${match.value.source || match.key}`,
      provenance: match.value.provenance ?? "reported",
      originalValue: match.value.originalValue ?? "",
      conversionNote: match.value.conversionNote ?? "",
    };
  });
  return { values: next, filledCount };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const task = body.task as string;

    if (task === "suggest_schema") {
      const { paperText } = body as { paperText: string };

      try {
        const { object } = await retryStreamObject({
          model: MODEL,
          maxOutputTokens: 4000,
          output: Output.object({
            schema: z.object({
              fields: z
                .array(
                  z.object({
                    name: z
                      .string()
                      .describe(
                        "Short, practical field name as it would appear as a spreadsheet column, e.g. 'catalyst', 'initial_pH', 'SBET', 'removal_efficiency'",
                      ),
                    type: z
                      .enum(["string", "number", "select"])
                      .describe("Data type for this field"),
                    description: z
                      .string()
                      .describe("One short sentence describing what this field captures"),
                    unit: z
                      .string()
                      .describe(
                        "Standard unit for this field if numeric (e.g. 'mM', 'min', '°C', 'm2/g'), else empty string",
                      ),
                    options: z
                      .array(z.string())
                      .describe(
                        "Only when type='select': the distinct option values seen in the paper, else empty array",
                      ),
                  }),
                )
                .describe(
                  "10-25 suggested fields worth extracting from this paper into a tabular dataset.",
                ),
            }),
          }),
          prompt: [
            "You are helping a researcher set up a data-extraction schema for a scientific paper BEFORE any data is extracted.",
            "Read the paper text below and suggest a practical list of FIELD NAMES worth extracting — the columns a spreadsheet of this paper's experimental data would need.",
            "Cover: identity of materials/catalysts used, oxidants/reagents and their dosages, key reaction conditions (pH, temperature, time, concentration...), and the outcome quantities plotted in the paper's figures (e.g. removal efficiency (%), rate constant k, concentration remaining).",
            "Prefer field names that match how the paper itself refers to the quantity. Keep the list focused and non-redundant.",
            "Respond with ONLY valid JSON matching the schema. No markdown, no code fences, no explanation.",
            "",
            "Paper text:",
            clip(paperText, 60000),
          ].join("\n\n"),
        });

        return Response.json(object as Record<string, unknown>);
      } catch (err) {
        console.error("extract/suggest_schema failed:", err);
        if (err instanceof DeadlineExceededError) {
          return Response.json({ error: err.message }, { status: 500 });
        }
        return Response.json(
          {
            error: "Model không trả về đúng định dạng JSON, thử lại giúp mình",
          },
          { status: 500 },
        );
      }
    }

    // Trích xuất MỘT LẦN cho cả bài báo (không lặp lại theo từng figure):
    // xây dựng "paper context" gồm 4 nhóm entity —
    //   - materials          (catalyst, precursor, support, ...)
    //   - oxidants           (peracetic acid, H2O2, persulfate, ...)
    //   - micropollutants    (carbamazepine, ...)
    //   - generalConditions  (điều kiện/hằng số mặc định dùng chung cho cả bài)
    // — mỗi entity kèm toàn bộ thông số/đặc tính hoá lý của nó (materials:
    // SBET, pHpzc, 2Theta, pore volume, kích thước hạt, thành phần nguyên tố...;
    // oxidants: MW, pKa, O-O bond dissociation energy, standard reduction
    // potential...; micropollutants: MW, LogKow, E/S/A/B/V...).
    // Kết quả này sẽ được front-end lưu lại (paperContext) và truyền sang mỗi
    // lần gọi "figure_extract" để dùng làm nguồn TRA CỨU (không phải suy luận)
    // khi field không tìm thấy trong text của riêng figure đó.
    // --- paper_context, split into two small tasks the CLIENT orchestrates ---
    //
    // This used to be one server-side task that internally chunked the paper
    // and scanned every chunk with mapWithConcurrency before responding.
    // Netlify's Next.js Server Handler enforces a hard ~30s synchronous
    // timeout on this whole route REGARDLESS of the `runtime`/`maxDuration`
    // exports above (confirmed from production function logs — the platform
    // kills the invocation outright at ~30s, well before our own
    // EDGE_BUDGET_MS deadline logic ever gets a chance to return a clean
    // JSON error), so a single request that has to wait on every chunk of a
    // real paper routinely got killed mid-response, and the browser saw a
    // raw non-JSON 502 instead of a result. Splitting this into two small,
    // independently-callable tasks — a one-shot naming pass and a
    // per-chunk scan — lets the CLIENT (components/steps/paper-
    // characteristics-step.tsx) fire one small request per chunk (each
    // finishes in a few seconds, comfortably under any platform timeout)
    // and merge the results itself using the same logic that used to run
    // here (now in lib/paper-context.ts, shared by client and server).

    // Naming-only pass: identifies every distinct material/oxidant/
    // micropollutant in the WHOLE paper in one small-output call, so every
    // per-chunk call below can be told to use the same canonical name for
    // the same real-world entity instead of each independently guessing one.
    if (task === "paper_context_names") {
      const { paperText } = body as { paperText: string };
      const entityNamesSchema = z.object({
        materials: z
          .array(
            z.object({
              name: z.string().describe("Canonical exact name for this material as used in the paper"),
              role: z
                .string()
                .describe(
                  "Role of this material in the study, e.g. 'catalyst', 'precursor', 'support', or empty string",
                ),
            }),
          )
          .describe(
            "Every DISTINCT catalyst, support, and precursor named anywhere in the paper — one entry per real-world entity, not per mention.",
          ),
        oxidants: z
          .array(z.object({ name: z.string().describe("Canonical exact name for this oxidant") }))
          .describe("Every DISTINCT oxidant named anywhere in the paper."),
        micropollutants: z
          .array(
            z.object({
              name: z.string().describe("Canonical exact name for this micropollutant / target compound"),
            }),
          )
          .describe(
            "Every DISTINCT micropollutant / target pollutant named anywhere in the paper.",
          ),
      });

      type EntityNames = {
        materials: { name: string; role?: string }[];
        oxidants: { name: string }[];
        micropollutants: { name: string }[];
      };

      try {
        const { object } = await retryStreamObject({
          model: MODEL,
          maxOutputTokens: 3000,
          output: Output.object({ schema: entityNamesSchema }),
          prompt: [
            "This is a NAMING-ONLY pass over a scientific paper — do NOT extract any property values, just identify every distinct entity.",
            "List every DISTINCT catalyst/support/precursor (as 'materials'), oxidant, and micropollutant/target-pollutant named anywhere in this paper.",
            "One entry per distinct real-world entity — if the paper introduces a material with a full descriptive name and later refers to it by a short abbreviation (e.g. 'CuFeO2 rhombohedral crystals (RCs)' later called just 'RCs' or 'CuFeO2 RCs'), that is ONE entity: pick whichever exact form the paper uses MOST OFTEN as its canonical 'name'.",
            "",
            "Respond with ONLY valid JSON matching the schema. No markdown, no code fences, no explanation.",
            "",
            "Paper text:",
            clip(paperText, 200_000),
          ].join("\n\n"),
        });
        return Response.json(object as EntityNames);
      } catch (err) {
        console.error("extract/paper_context_names failed:", err);
        if (err instanceof DeadlineExceededError) {
          return Response.json({ error: err.message }, { status: 500 });
        }
        return Response.json(
          {
            error: "Model không trả về đúng định dạng JSON, thử lại giúp mình",
          },
          { status: 500 },
        );
      }
    }

    // Per-chunk scan: extracts materials/oxidants/micropollutants/
    // generalConditions found in ONE chunk of the paper, using the canonical
    // entity names from "paper_context_names" (if provided) so results merge
    // cleanly across chunks once the client combines them (see
    // lib/paper-context.ts's mergeEntityLists/mergeFieldValueArrays). No
    // chunking or looping happens here — the CLIENT already sliced the paper
    // (lib/paper-context.ts's chunkText) and calls this once per chunk.
    if (task === "paper_context_chunk") {
      const {
        chunkText: text,
        chunkIndex,
        totalChunks,
        knownEntities,
      } = body as {
        chunkText: string;
        chunkIndex: number;
        totalChunks: number;
        knownEntities?: {
          materials?: { name: string; role?: string }[];
          oxidants?: { name: string }[];
          micropollutants?: { name: string }[];
        };
      };

      const knownEntitiesBlock = [
        knownEntities?.materials?.length
          ? `Materials: ${knownEntities.materials.map((m) => `"${m.name}"${m.role ? ` (${m.role})` : ""}`).join(", ")}`
          : "Materials: (none identified)",
        knownEntities?.oxidants?.length
          ? `Oxidants: ${knownEntities.oxidants.map((o) => `"${o.name}"`).join(", ")}`
          : "Oxidants: (none identified)",
        knownEntities?.micropollutants?.length
          ? `Micropollutants: ${knownEntities.micropollutants.map((m) => `"${m.name}"`).join(", ")}`
          : "Micropollutants: (none identified)",
      ].join("\n");

      const paperContextSchema = z.object({
        materials: z
          .array(
            z.object({
              name: z
                .string()
                .describe(
                  "Exact material name as referred to in the paper, e.g. 'Cu-rGO LDH', 'Mn-rGO LDH', 'rGO', 'Fe3O4'",
                ),
              role: z
                .string()
                .describe(
                  "Role of this material in the study, e.g. 'catalyst', 'precursor', 'support', 'benchmark catalyst', or empty string",
                ),
              values: z
                .array(fieldValueSchema)
                .describe(
                  "One entry for EACH of these REQUIRED characterization properties — 'Support type', 'Size', 'SBET', 'Pore volume', 'Average pore size', 'pHpzc', '2Theta' — PLUS one entry for every OTHER characterization property reported for this material in THIS excerpt (elemental composition, crystallite size, rate constant, etc.). These are the material's own measured/experimental data: NEVER use provenance='looked_up' for any of them — if not reported in this excerpt, value='' and provenance='not_reported' (it may still be reported elsewhere in the paper, in another excerpt).",
                ),
            }),
          )
          .describe(
            "Every catalyst, support, and precursor actually named in THIS excerpt.",
          ),
        oxidants: z
          .array(
            z.object({
              name: z
                .string()
                .describe(
                  "Exact oxidant name as referred to in the paper, e.g. 'Peracetic acid', 'H2O2', 'Persulfate'",
                ),
              values: z
                .array(fieldValueSchema)
                .describe(
                  "One entry for EACH of these REQUIRED properties — 'Chemical formula/species', 'MW', 'O-O bond dissociation energy', 'Standard reduction potential' (name the relevant half-reaction), 'pKa' — PLUS any other physicochemical property reported for this oxidant. These are universal physicochemical constants: if not stated in this excerpt, you MAY use provenance='looked_up' from established chemistry knowledge for the EXACT chemical species involved (state that species in conversionNote). If the oxidant has no O-O bond, value='Not applicable' with provenance='not_applicable' for that entry.",
                ),
            }),
          )
          .describe("Every oxidant actually named in THIS excerpt."),
        micropollutants: z
          .array(
            z.object({
              name: z
                .string()
                .describe(
                  "Exact micropollutant / target compound name as referred to in the paper, e.g. 'Carbamazepine'",
                ),
              values: z
                .array(fieldValueSchema)
                .describe(
                  "One entry for EACH of these REQUIRED properties — 'MW', 'LogKow', 'E', 'S', 'A', 'B', 'V' (Abraham solvation/LSER descriptors) — PLUS any other physicochemical property reported for this micropollutant. These are universal physicochemical constants: if not stated in this excerpt, you MAY fill it from reliable established chemistry/literature knowledge with provenance='looked_up'. Never invent E/S/A/B/V — if a reliable value cannot be established, value='' and provenance='not_reported'.",
                ),
            }),
          )
          .describe(
            "Every micropollutant / target pollutant actually named in THIS excerpt.",
          ),
        generalConditions: z
          .array(fieldValueSchema)
          .describe(
            "Paper-wide default/fixed reaction conditions NOT tied to one specific material/oxidant/micropollutant — e.g. temperature, catalyst dosage, oxidant dosage, initial pH, reaction volume, HPLC wavelength, column type, flow rate — ONLY if THIS excerpt explicitly frames them as a general/shared condition (e.g. in Materials & Methods, or a figure caption that says 'unless otherwise noted').",
          ),
        notes: z
          .string()
          .describe(
            "Short note on anything ambiguous in THIS excerpt, or empty string",
          ),
      });

      try {
        const { object } = await retryStreamObject({
          model: MODEL,
          maxOutputTokens: 8000,
          output: Output.object({ schema: paperContextSchema }),
          prompt: [
            "You are building a structured reference context (paper context) from ONE EXCERPT of a larger scientific paper, covering four kinds of entities: materials, oxidants, micropollutants, and general reaction conditions.",
            "",
            "IMPORTANT: this excerpt is only PART of the full paper — text may start/end mid-sentence, and an entity named here may have more of its properties reported elsewhere in the paper (in another excerpt you can't see). That's expected: only report what THIS excerpt actually states, and don't worry about completeness across the whole paper — the excerpts are merged together afterwards.",
            "The excerpt may also be part of a merged 'SUPPLEMENTARY INFORMATION' section (from a separate SI PDF) — treat it with EQUAL weight as the main text: SI commonly holds exactly the characterization values (SBET, pHpzc, oxidant MW, LogKow...) this task needs.",
            "",
            "KNOWN ENTITIES — already identified from a first pass over the WHOLE paper. If an entity you find in this excerpt matches one of these (even if THIS excerpt calls it something slightly different, e.g. a different abbreviation), you MUST use the EXACT name string given here as its 'name', so results merge correctly across excerpts. Only use a name NOT in this list if this excerpt clearly describes an entity genuinely absent from it.",
            knownEntitiesBlock,
            "",
            "INSTRUCTIONS:",
            "1. Identify every catalyst, support, and precursor named in THIS excerpt, and list it under 'materials' (using the matching KNOWN ENTITIES name when applicable). Do not list a material unless this excerpt actually names it.",
            "2. Identify every oxidant named in THIS excerpt, and list it under 'oxidants' (using the matching KNOWN ENTITIES name when applicable).",
            "3. Identify every micropollutant / target pollutant named in THIS excerpt, and list it under 'micropollutants' (using the matching KNOWN ENTITIES name when applicable).",
            "4. For every material you list, you MUST emit one entry for each REQUIRED property (Support type, Size, SBET, Pore volume, Average pore size, pHpzc, 2Theta) — never silently skip one just because it's absent from this excerpt, emit it with value='' and provenance='not_reported' instead. Plus extract every OTHER characterization property this excerpt reports for it (elemental composition, crystallite size, rate constant, etc.). These are all this material's OWN measured/experimental data from THIS paper — NEVER look these up externally, NEVER invent them.",
            "5. For every oxidant you list, you MUST emit one entry for each REQUIRED property (Chemical formula/species, MW, O-O bond dissociation energy, Standard reduction potential, pKa), plus any other physicochemical property this excerpt reports. These are universal physicochemical constants for the oxidant species itself (not measured by this paper's authors): if this excerpt doesn't state one, you MAY fill it from reliable general chemistry knowledge with provenance='looked_up', but you MUST first pin down the EXACT chemical species involved (e.g. is 'PMS' the free HSO5- anion, or a specific commercial triple-salt formulation?) and name that species + the source/basis in 'conversionNote'. If ambiguous, prefer leaving it not_reported over guessing the wrong species. If the oxidant has no O-O bond, report that property as value='Not applicable', provenance='not_applicable'.",
            "6. For every micropollutant you list, you MUST emit one entry for each REQUIRED property (MW, LogKow, E, S, A, B, V), plus any other physicochemical property this excerpt reports. These are universal physicochemical constants: if this excerpt doesn't state one, you MAY fill it from reliable chemistry/literature knowledge with provenance='looked_up', citing the basis in 'conversionNote'. Never invent Abraham descriptors (E/S/A/B/V) — if a reliable value isn't known, value='' and provenance='not_reported'.",
            "7. Extract default/shared reaction conditions into 'generalConditions', only if THIS excerpt explicitly frames them as default/shared (e.g. temperature, catalyst dosage, oxidant dosage, initial pH, reaction volume). These come from THIS paper only — provenance='reported', never looked_up.",
            "8. For every value, 'source' must be a short quote or section/figure reference supporting it (e.g. 'Section 3.1, BET surface area 148.69 m2/g'), or for a looked_up value, note it's from general knowledge (e.g. 'General chemistry knowledge').",
            "9. If a paper-specific property is mentioned only qualitatively (e.g. 'high surface area') without a number, treat it as not_reported — only extract concrete values as 'reported'.",
            "10. Never invent or infer a value for this paper's OWN measured/experimental data (materials' characterization properties, generalConditions). The only category where filling in an unstated value is allowed is universal physicochemical constants (oxidant/micropollutant properties per rules 5-6), and only when clearly labeled provenance='looked_up' with its basis stated.",
            "11. If this excerpt names no material, oxidant, or micropollutant at all, return empty arrays for those — do not force an entry.",
            "",
            "Respond with ONLY valid JSON matching the schema. No markdown, no code fences, no explanation.",
            "",
            `Excerpt ${chunkIndex + 1} of ${totalChunks} (paper split into sections for processing):`,
            text,
          ].join("\n\n"),
        });
        return Response.json(object as Record<string, unknown>);
      } catch (err) {
        console.error(`extract/paper_context_chunk ${chunkIndex} failed:`, err);
        if (err instanceof DeadlineExceededError) {
          return Response.json({ error: err.message }, { status: 500 });
        }
        if (err && typeof err === "object" && "text" in err) {
          console.error(
            "Raw model output that failed to parse:",
            (err as any).text,
          );
        }
        return Response.json(
          {
            error: "Model không trả về đúng định dạng JSON, thử lại giúp mình",
          },
          { status: 500 },
        );
      }
    }

    if (task === "figures") {
      const { paperText } = body as { paperText: string };

      // One shared deadline for the WHOLE task — every chunk call below races
      // against this same absolute time, so running them in parallel doesn't
      // silently push the total wall-clock time past the platform's timeout.
      const taskDeadline = Date.now() + EDGE_BUDGET_MS;

      const CHUNK_SIZE = 9000;
      const CHUNK_OVERLAP = 500;
      const MAX_CONCURRENT_CHUNKS = 16;
      // Generous cap just so a pathological input can't create an unbounded
      // number of chunks — this is much higher than the old hard 15000-char
      // clip, so in practice the WHOLE paper gets scanned now, not just the
      // first ~15k characters of it.
      const MAX_TOTAL_PAPER_CHARS = 200_000;

      const figureSchema = z.object({
        label: z.string().describe("e.g. 'Figure 1', 'Fig. 2a'"),
        caption: z
          .string()
          .describe("The figure caption if available, else empty string"),
        description: z.string().describe("What the figure shows / plots"),
        xAxis: z.string().describe("X-axis quantity and unit, or empty string"),
        yAxis: z.string().describe("Y-axis quantity and unit, or empty string"),
        sweepVariable: z
          .string()
          .describe(
            "The parameter that differs between curveLabels / curves in this figure (i.e. what's swept between series), or empty string. Do NOT put xAxis or yAxis here — this is specifically the between-curve variable.",
          ),
        curveLabels: z
          .array(z.string())
          .describe("Labels of the curves/series shown"),
      });

      const chunks = chunkText(
        clip(paperText, MAX_TOTAL_PAPER_CHARS),
        CHUNK_SIZE,
        CHUNK_OVERLAP,
      );

      let chunkFailures = 0;

      async function scanChunk(
        text: string,
        index: number,
      ): Promise<RawFigure[]> {
        try {
          const { object } = await retryStreamObject(
            {
              model: MODEL,
              maxOutputTokens: 8000,
              output: Output.object({
                schema: z.object({ figures: z.array(figureSchema) }),
              }),
              prompt: [
                "Build an inventory of the FIGURES referenced in the excerpt below.",
                "",
                "IMPORTANT: this excerpt is only PART of a larger scientific paper — text may start/end mid-sentence, and some figures mentioned here may be described more fully in another part of the paper you can't see. That's expected and fine.",
                "Only report a figure/panel if THIS excerpt actually contains a figure reference or caption for it (a label like 'Figure'/'Fig.' followed by a number). Do not invent figures that aren't mentioned here, and don't worry about figures that belong only to other parts of the paper.",
                "When a figure has distinct labeled panels (a), (b), (c), (d), list each panel as a separate item (e.g. Figure 4a, Figure 4b) whenever this excerpt gives panel-specific information. Otherwise list the figure once.",
                "For each figure/panel found, describe what it plots and identify axes and any curve/series labels, using ONLY information present in this excerpt.",
                "If this excerpt contains no figure reference at all, return an empty 'figures' array — do not force an entry.",
                "Respond with ONLY valid JSON matching the schema. No markdown, no code fences, no explanation.",
                "",
                `Excerpt ${index + 1} of ${chunks.length} (paper split into sections for processing):`,
                text,
              ].join("\n\n"),
            },
            1, // small call now — 1 retry is plenty
            taskDeadline,
          );
          return (object as { figures: RawFigure[] }).figures ?? [];
        } catch (err) {
          // One slow/failed section shouldn't sink the whole scan — log it,
          // skip it, and let the rest of the paper's figures still come back.
          chunkFailures++;
          console.error(`extract/figures chunk ${index} failed:`, err);
          return [];
        }
      }

      try {
        const chunkResults = await mapWithConcurrency(
          chunks,
          MAX_CONCURRENT_CHUNKS,
          scanChunk,
        );

        // Combine xAxis + yAxis + the between-curve sweep variable into a single
        // 'changingVariable' array. Done here in code (not left to the LLM) so it's
        // deterministic and doesn't cost extra tokens/another model call.
        const rawFigures = mergeFigures(chunkResults.flat());

        const figures = rawFigures.map(({ sweepVariable, ...rest }) => {
          const changingVariable = Array.from(
            new Set(
              [rest.xAxis, rest.yAxis, sweepVariable]
                .map((s) => s?.trim())
                .filter((s): s is string => Boolean(s)),
            ),
          );
          return { ...rest, changingVariable };
        });

        return Response.json({
          figures,
          // Lets the front-end optionally warn the user that a few sections
          // of a very long paper couldn't be scanned in time, instead of
          // silently returning an incomplete list with no explanation.
          ...(chunkFailures > 0
            ? { partial: true, chunkFailures, totalChunks: chunks.length }
            : {}),
        });
      } catch (err) {
        console.error("extract/figures failed:", err);
        if (err instanceof DeadlineExceededError) {
          return Response.json({ error: err.message }, { status: 500 });
        }
        if (err && typeof err === "object" && "text" in err) {
          console.error(
            "Raw model output that failed to parse:",
            (err as any).text,
          );
        }
        return Response.json(
          {
            error: "Model không trả về đúng định dạng JSON, thử lại giúp mình",
          },
          { status: 500 },
        );
      }
    }

    if (task === "figure_extract") {
      const {
        figure,
        fields,
        paperText,
        paperContext,
        xField,
        yField,
        seriesField,
      } = body as {
        figure: {
          xAxis?: string;
          yAxis?: string;
          changingVariable?: string[];
          curveLabels?: string[];
          [key: string]: unknown;
        };
        fields: {
          name: string;
          type: string;
          description?: string;
          unit?: string;
          options?: string[];
        }[];
        paperText: string;
        // paperContext = kết quả trả về của task "paper_context":
        // { materials: [...], oxidants: [...], micropollutants: [...],
        //   generalConditions: [...], notes }
        paperContext?: {
          materials?: unknown[];
          oxidants?: unknown[];
          micropollutants?: unknown[];
          generalConditions?: unknown[];
          [key: string]: unknown;
        };
        xField?: string;
        yField?: string;
        seriesField?: string;
      };
      console.log("figure_extract for:", figure);
      console.log("fields to extract:", fields);
      console.log("paperContext provided:", !!paperContext);

      // changingVariable + curveLabels đã được xác định TỪ TRƯỚC ở task "figures"
      // (không cần hỏi lại model ở đây). Không đưa 2 giá trị này vào đầu prompt
      // (sẽ phá cache prefix) — thay vào đó, prompt chỉ dạy model CÁCH dùng
      // 2 trường changingVariable/curveLabels vốn đã có sẵn trong Figure JSON
      // (nằm cuối prompt) làm ground truth, để bỏ qua field trùng và chỉ tìm
      // giá trị cho fixedVariable còn lại. Sau khi model trả lời, ta echo lại
      // 2 giá trị này y nguyên (không cần model trả lại, không cần gộp ở code).
      const knownChangingVariable = figure?.changingVariable ?? [];
      const knownCurveLabels = figure?.curveLabels ?? [];

      try {
        const { object } = await retryStreamObject({
          model: MODEL,
          output: Output.object({
            schema: z.object({
              values: z.array(fieldValueSchema),
              changingFieldNames: z
                .array(z.string())
                .describe(
                  "Exact 'name' values (must match a name in 'Fields' exactly) that you classified per rule 1-2 as matching this figure's changingVariable or curveLabels, and therefore left empty in 'values'.",
                ),
              notes: z
                .string()
                .describe(
                  "Short rationale explaining how the fixed-variable values were determined for this figure, or empty string",
                ),
            }),
          }),
          prompt: [
            "You are extracting values for the FIXED VARIABLES of ONE SPECIFIC figure in a scientific paper.",
            "",
            "CONTEXT:",
            "- 'Figure' below is rich metadata about this exact figure/panel, including its already-determined 'changingVariable' (quantities that vary WITHIN each curve, e.g. its axes) and 'curveLabels' (the quantity that VARIES BETWEEN curves, if this figure has multiple series). Both are already decided — do not re-derive them, just use them. DO NOT infer any additional changing variables",
            "- 'Fields' is the full list of fields you must produce an answer for (a value, or an intentional empty string).",
            "- 'Digitization columns' below identify which schema fields correspond to the digitized x, y, and series output columns. These are structural output columns from digitization, not values extracted from paper text — treat them as OFF-LIMITS exactly like changingVariable/curveLabels.",
            "",
            "RULES:",
            "1. FIRST, for every field in 'Fields', decide whether it semantically matches one of the Figure's already-determined 'changingVariable' entries or its 'curveLabels' quantity — match by meaning, not exact string (e.g. field 'pH' matches a curveLabels quantity described as 'Initial pH'). Every field name you classify this way MUST be added to 'changingFieldNames', using the exact 'name' string as given in 'Fields'. The ONLY evidence allowed for this classification is the literal 'changingVariable' array and 'curveLabels' value given below for THIS figure — do NOT classify a field as changing just because that same quantity happens to be swept across OTHER figures/experiments elsewhere in the paper, or because it seems like the kind of thing that COULD vary in general. A field absent from THIS figure's 'changingVariable'/'curveLabels' is a fixed variable for THIS figure, full stop, even if some other figure in the paper varies it.",
            "2. The fields mapped to digitization output columns ('digitizationXField', 'digitizationYField', 'digitizationSeriesField') are OFF-LIMITS — they represent the structural columns of the digitized dataset, not values extracted from paper text. Treat them exactly like changingVariable/curveLabels: return value = '' and confidence = 0, and add them to 'changingFieldNames'.",
            "3. If a field matches EITHER a 'changingVariable' entry OR the 'curveLabels' quantity OR is a digitization column — no matter whether it varies within each curve (axis) or between curves (series) — it is OFF-LIMITS: always return value = '' and confidence = 0 for that field. This applies with NO exceptions, even if the paper text states a seemingly fixed number for it (e.g. a total duration, an endpoint, or any other scalar) — that field belongs to the varying quantity for this figure and must stay empty here.",
            "4. For all OTHER fields — the FIXED VARIABLES, i.e. fields that do NOT match 'changingVariable' or 'curveLabels' — determine their value normally. Treat the Figure's caption/description as ground truth for this figure's specific condition, and ground the value in the figure metadata or the paper text (e.g. the experimental setup / methods section for conditions shared across figures such as material, oxidant, dosages, etc.).",
            "5. If a fixed-variable field's value truly cannot be determined even from the general experimental setup in the paper, return empty string with confidence 0 rather than guessing.",
            "6. For fields with an 'options' list, only return one of those exact option strings, or empty string if none apply.",
            "7. 'source' should be a short quote or location (e.g. figure caption, section name) that supports the value.",
            "8. CRITICAL — avoid cross-figure contamination: the paper text may contain OTHER sections describing a DIFFERENT figure/panel where some field (e.g. pH, temperature, dosage, concentration, time) is swept across several values (e.g. 'pH = 4, 6, 8, 10'). That sweep belongs ONLY to that other figure, not to this one. Do not borrow one of those swept values for a fixed-variable field here — either return empty string with confidence 0, or use a fixed/default value ONLY if the text explicitly states it applies broadly (e.g. a general experimental conditions caption that lists fixed parameters for a whole figure set, such as '[TC] = 45 µM, T = 28°C unless otherwise noted').",
            "9. Never assume a field takes a value just because numbers for that field exist somewhere in the paper — verify those numbers are actually associated with THIS figure before using them.",
            "10. FALLBACK — 'Paper context' (if provided below) is a pre-built reference table extracted once from the WHOLE paper (so it may contain properties that fall outside the 'Paper text' excerpt given here). It has four parts: 'materials' (catalysts/supports/precursors), 'oxidants', 'micropollutants', and 'generalConditions' (paper-wide default/shared conditions not tied to one specific entity). If a fixed-variable field is still empty after checking 'Paper text', resolve it by LOOKUP ONLY (never infer or compute a new value):",
            "   a. Identify which entity the field belongs to: is it a property of a material/catalyst, of an oxidant, of a micropollutant, or is it a general paper-wide condition?",
            "   b. Identify WHICH specific entity of that type this figure/curve is about (e.g. which catalyst, which oxidant, which micropollutant) — only proceed if that entity is already clear from the figure/curve context; do not guess it.",
            "   c. Look up that exact entity by name in the matching array of 'Paper context' ('materials' / 'oxidants' / 'micropollutants'), or check 'generalConditions' directly if the field is a shared condition rather than tied to one entity.",
            "   d. Copy that entity's matching property value — match by meaning, not exact string (e.g. field 'SBET (catalyst)' matches a materials property named 'BET surface area'; field 'MW (oxidant)' matches an oxidants property named 'MW'; field 'LogKow' matches a micropollutants property of the same name).",
            "   Set 'source' to mention it came from Paper context (e.g. 'Paper context: Cu-rGO LDH (materials), BET surface area'). Do NOT use a property belonging to a DIFFERENT entity than the one this figure/curve is about, and never invent a value that isn't explicitly present in 'Paper context' or 'Paper text'. Copy the source entry's 'provenance' as-is (if it was 'looked_up' there, it stays 'looked_up' here — do not relabel it 'reported').",
            "11. UNIT CONVERSION — each entry in 'Fields' may carry a 'unit' (the standardized unit this dataset wants). If the paper reports the same quantity in a DIFFERENT unit, you must: (a) put the paper's exact value+unit string in 'originalValue' (e.g. '0.5 g/L'), (b) compute the standardized value in the field's unit into 'value' (e.g. '4.42' for a field whose unit is 'mM'), (c) set provenance='derived', and (d) write the formula, the EXACT chemical species assumed, and the MW used into 'conversionNote' (e.g. 'PMS as HSO5-, MW 113.07 g/mol: 0.5 g/L / 113.07 g/mol x 1000 = 4.42 mM'). NEVER pick a molecular weight for a generic/commercial formulation name (e.g. 'PMS', 'Oxone') without first deciding the exact species intended — if genuinely ambiguous, still convert using the most standard interpretation but say so in 'conversionNote'. If the paper's unit already matches the field's unit, leave 'originalValue' empty and provenance='reported' (no conversion happened). NEVER silently overwrite the paper's original value without preserving it in 'originalValue'.",
            "12. Some fields are IDENTITY fields naming which material/catalyst/oxidant/micropollutant/etc. is involved. When such a field genuinely does not apply to this figure's system (e.g. a 'Catalyst' field when this curve is an oxidant-only control with no catalyst), return value='None / Not applicable' and provenance='not_applicable' — this is different from 'could not determine', which is value='' with confidence=0 and provenance='not_reported'. Never leave an identity field as a bare empty string when the true answer is 'none used'.",
            "13. PROVENANCE — every entry in 'values' must set 'provenance': 'reported' when the value came directly from this figure/paper text; 'derived' when computed via unit conversion (rule 11); 'not_applicable' when the concept doesn't apply (rule 12); 'not_reported' when it could not be determined; or the inherited value from rule 10 when resolved via Paper context fallback (which may itself be 'looked_up').",
            "",

            // IMPORTANT — prompt-caching order: OpenAI's automatic prompt caching
            // matches on a shared PREFIX across requests (>=1024 tokens). Everything above this point plus
            // 'Fields' and 'Paper text' below are IDENTICAL on every figure_extract
            // call for the same paper/schema, so they form a stable, cacheable
            // prefix. 'Figure', and 'Materials context' are the
            // per-call-varying parts, so they must stay AFTER 'Fields' and 'Paper text'.
            // Do not move any per-call-varying content earlier — that breaks the
            // prefix match for everything that follows it.
            "Fields to extract (JSON):",
            JSON.stringify(fields, null, 2),
            "Paper text:",
            clip(paperText, 150000),
            "Figure (JSON) — the specific figure/panel to extract values for, including its already-determined changingVariable and curveLabels:",
            JSON.stringify(figure, null, 2),
            "Digitization columns:",
            JSON.stringify(
              {
                digitizationXField: xField ?? null,
                digitizationYField: yField ?? null,
                digitizationSeriesField: seriesField ?? null,
              },
              null,
              2,
            ),
            // Đặt SAU 'Figure' (không đặt sớm hơn) vì đây cũng là phần thay đổi
            // theo call/context giống 'Figure', không ảnh hưởng tới cache prefix
            // ổn định của 'Fields' + 'Paper text' phía trên.
            "Paper context (JSON) - reference table of materials/oxidants/micropollutants/generalConditions, built once from the whole paper. Use ONLY as fallback per rule 10 (lookup only, never infer):",
            paperContext
              ? JSON.stringify(paperContext, null, 2)
              : "(none provided)",
          ].join("\n\n"),
        });

        // Debug: confirm whether key characterization terms actually made it
        // into the text sent to the model (not just into the raw paperText).
        {
          const sentText = clip(paperText, 150000);
          const checks = ["BET surface area", "pHpzc", "2θ", "2Theta"];
          console.log(
            "[debug figure_extract] paperText.length =",
            paperText.length,
            "| sent to model =",
            sentText.length,
          );
          for (const term of checks) {
            console.log(
              `[debug figure_extract] "${term}" in sentText?`,
              sentText.includes(term),
            );
          }
        }

        // changingVariable/curveLabels được echo lại nguyên trạng từ input —
        // đã xác định TRƯỚC prompt rồi, không cần model trả lại hay code gộp
        // sau nữa.
        //
        // Các cột x/y/series được xác định ở bước digitize là output cấu trúc
        // của quá trình số hóa — không phải giá trị trích xuất từ paper text —
        // nên force thêm vào changingFieldNames để frontend hiển thị đúng group
        // "biến thay đổi" (để trống).
        const digitizationColumns = [xField, yField, seriesField].filter(
          (n): n is string => typeof n === "string" && n.trim().length > 0,
        );

        const llmResult = object as {
          values: LooseFieldValue[];
          changingFieldNames: string[];
          notes: string;
        };
        const mergedChangingFieldNames = Array.from(
          new Set([...llmResult.changingFieldNames, ...digitizationColumns]),
        );

        // Deterministic safety net: fill any field the model left empty but
        // that paper_context already has an unambiguous value for.
        const fallbackCandidates = buildFallbackCandidates(paperContext);
        const { values: filledValues, filledCount } = applyFallbackFill(
          llmResult.values,
          fields,
          new Set(mergedChangingFieldNames),
          fallbackCandidates,
        );
        if (filledCount > 0) {
          console.log(
            `[figure_extract] fallback-filled ${filledCount} field(s) from paper context`,
          );
        }

        return Response.json({
          ...llmResult,
          values: filledValues,
          changingFieldNames: mergedChangingFieldNames,
          changingVariable: knownChangingVariable,
          curveLabels: knownCurveLabels,
        });
      } catch (err) {
        console.error("extract/figure_extract failed:", err);
        if (err instanceof DeadlineExceededError) {
          return Response.json({ error: err.message }, { status: 500 });
        }
        if (err && typeof err === "object" && "text" in err) {
          console.error(
            "Raw model output that failed to parse:",
            (err as any).text,
          );
        }
        return Response.json(
          {
            error: "Model không trả về đúng định dạng JSON, thử lại giúp mình",
          },
          { status: 500 },
        );
      }
    }

    return Response.json({ error: "Unknown task" }, { status: 400 });
  } catch (err) {
    console.error(
      "[v0] extract error:",
      err instanceof Error ? err.message : err,
    );
    // Thêm đoạn này để dump raw output
    if (err && typeof err === "object") {
      console.error("[v0] finishReason:", (err as any).finishReason);
      console.error("[v0] usage:", JSON.stringify((err as any).usage, null, 2));
      console.error(
        "[v0] response:",
        JSON.stringify((err as any).response, null, 2),
      );
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "Extraction failed" },
      { status: 500 },
    );
  }
}
