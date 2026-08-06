import { streamText, Output } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { getTextForTask } from "@/lib/paper-sections";

export const runtime = "edge";
export const maxDuration = 60;

const openaiProvider = createOpenAI();
// gpt-4.1-mini: mạnh hơn hẳn gpt-4.1-nano ở khả năng đọc hiểu & trích xuất
// chi tiết (nano quá yếu, dễ bỏ sót thông tin dù vẫn còn dư token output),
// vẫn khá rẻ so với gpt-4o/gpt-4.1 full, trần output 32.768 tokens.
// Có hỗ trợ vision — task "image_params" (đọc ảnh) dùng được với model này.
//
// QUAN TRỌNG: OpenAI (cả Responses API lẫn Chat Completions API) dùng
// "strict" JSON schema mode cho generateObject, bắt buộc MỌI field phải nằm
// trong mảng "required" của schema. Zod converter coi field có .default(...)
// là KHÔNG bắt buộc (optional) trong JSON Schema sinh ra, nên bất kỳ field
// nào dùng .default("") / .default([]) đều gây lỗi 400 "Invalid schema ...
// Missing '<field>'". Do đó toàn bộ .default(...) trong các schema bên dưới
// đã được bỏ — model vẫn được dặn qua .describe(...) rằng phải trả về ""/[]
// khi không tìm thấy dữ liệu, hành vi thực tế không đổi so với lúc dùng
// DeepSeek.
const MODEL = openaiProvider.chat("gpt-4.1-mini");

// Netlify Edge Functions have a HARD 40s "response header" timeout that cannot
// be raised (see docs.netlify.com/build/edge-functions/limits) — this is what's
// actually producing the raw HTML "504" the front-end has to special-case.
// Next.js's `export const maxDuration = 60` above is a Vercel-only hint and is
// silently ignored on Netlify, so it does nothing here.
//
// Instead of hoping every call finishes in time, we race each model call
// against an internal budget comfortably under 40s. If we're about to run out,
// we abort the in-flight request and return a clean JSON error ourselves —
// so the client ALWAYS gets JSON back, never a bare infra-level 504 page.
const NETLIFY_EDGE_BUDGET_MS = 26_000;

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
  deadline: number = Date.now() + NETLIFY_EDGE_BUDGET_MS,
): Promise<{ object: unknown }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline - Date.now();
    // Don't start another attempt we have no realistic chance of finishing —
    // failing fast here with clean JSON beats letting Netlify's own 40s
    // cutoff hand the browser a raw HTML 504 instead.
    if (remaining < 4000) {
      throw lastError ?? new DeadlineExceededError();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const result = streamText({
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

      if (aborted) break; // budget's gone — no point trying again
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
    .describe("Extracted value as a string, or empty string if not found"),
  confidence: z.number().min(0).max(1).describe("Confidence 0-1"),
  source: z
    .string()
    .describe("Short quote or location supporting the value, or empty string"),
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
// run past Netlify's 40s Edge Function cutoff for papers with many figures.

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

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const task = body.task as string;

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
    if (task === "paper_context") {
      const { paperText } = body as { paperText: string };

      try {
        const { object } = await retryStreamObject({
          model: MODEL,
          maxOutputTokens: 30000, // gpt-4.1-nano: tối đa 32768 completion tokens
          output: Output.object({
            schema: z.object({
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
                        "EVERY characterization property reported for this specific material anywhere in the paper: BET surface area, pore volume, pHpzc, XRD 2Theta / d-spacing, particle/crystallite size, elemental composition (Cu/Mg/Al/C %), degradation rate constant, etc. Do not limit yourself to a fixed list — extract everything found and give each its own entry with a clear 'name'.",
                      ),
                  }),
                )
                .describe(
                  "Every catalyst, support, and precursor mentioned in the paper.",
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
                        "EVERY physicochemical property reported for this oxidant anywhere in the paper: MW, pKa, O-O bond dissociation energy, standard reduction potential, etc. Be exhaustive — extract everything found and give each its own entry with a clear 'name'.",
                      ),
                  }),
                )
                .describe("Every oxidant used/mentioned in the paper."),
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
                        "EVERY physicochemical property reported for this micropollutant anywhere in the paper: MW, LogKow, E, S, A, B, V (Abraham solvation parameters), etc. Be exhaustive — extract everything found and give each its own entry with a clear 'name'.",
                      ),
                  }),
                )
                .describe(
                  "Every micropollutant / target pollutant studied in the paper.",
                ),
              generalConditions: z
                .array(fieldValueSchema)
                .describe(
                  "Paper-wide default/fixed reaction conditions NOT tied to one specific material/oxidant/micropollutant — e.g. temperature, catalyst dosage, oxidant dosage, initial pH, reaction volume, HPLC wavelength, column type, flow rate — ONLY if explicitly stated as a general/shared condition (e.g. in Materials & Methods or a figure caption that says 'unless otherwise noted').",
                ),
              notes: z
                .string()
                .describe(
                  "Short summary of coverage / anything ambiguous, or empty string",
                ),
            }),
          }),
          prompt: [
            "You are building a COMPLETE, structured reference context (paper context) for this scientific paper, covering four kinds of entities: materials, oxidants, micropollutants, and general reaction conditions.",
            "",
            "INSTRUCTIONS:",
            "1. Scan the ENTIRE paper text: abstract, materials & methods, characterization, results & discussion, conclusion.",
            "2. Identify every catalyst, support, and precursor by its exact name as used in the paper, and list it under 'materials'.",
            "3. Identify every oxidant used or mentioned in the paper, and list it under 'oxidants'.",
            "4. Identify every micropollutant / target pollutant studied in the paper, and list it under 'micropollutants'.",
            "5. For every material, extract EVERY characterization property reported for it anywhere in the text: surface area (SBET), pore volume, pHpzc, XRD peak positions / 2Theta / d-spacing, particle or crystallite size, elemental composition (wt% or %), rate constants, activation energy, dosage used, etc. Be exhaustive — do not stop at the first property you find.",
            "6. For every oxidant, extract EVERY physicochemical property reported for it anywhere in the text: MW, pKa, O-O bond dissociation energy, standard reduction potential, etc. Be exhaustive.",
            "7. For every micropollutant, extract EVERY physicochemical property reported for it anywhere in the text: MW, LogKow, E, S, A, B, V, etc. Be exhaustive.",
            "8. Extract all default/shared reaction conditions that apply broadly across the paper (not tied to one specific material/oxidant/micropollutant) into 'generalConditions', only if the text explicitly frames them as default/shared (e.g. temperature, catalyst dosage, oxidant dosage, initial pH, reaction volume).",
            "9. For every value, 'source' must be a short quote or section/figure reference supporting it (e.g. 'Section 3.1, BET surface area 148.69 m2/g').",
            "10. If a property is mentioned only qualitatively (e.g. 'high surface area') without a number, skip it — only extract concrete values.",
            "11. Do not invent or infer values that are not explicitly stated.",
            "",
            "Respond with ONLY valid JSON matching the schema. No markdown, no code fences, no explanation.",
            "",
            "Paper text:",
            clip(paperText, 20000),
          ].join("\n\n"),
        });

        return Response.json(object as Record<string, unknown>);
      } catch (err) {
        console.error("extract/paper_context failed:", err);
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
      // silently push the total wall-clock time past Netlify's 40s cutoff.
      const taskDeadline = Date.now() + NETLIFY_EDGE_BUDGET_MS;

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
            "1. FIRST, for every field in 'Fields', decide whether it semantically matches one of the Figure's already-determined 'changingVariable' entries or its 'curveLabels' quantity — match by meaning, not exact string (e.g. field 'pH' matches a curveLabels quantity described as 'Initial pH'). Every field name you classify this way MUST be added to 'changingFieldNames', using the exact 'name' string as given in 'Fields'. ",
            "2. The fields mapped to digitization output columns ('digitizationXField', 'digitizationYField', 'digitizationSeriesField') are OFF-LIMITS — they represent the structural columns of the digitized dataset, not values extracted from paper text. Treat them exactly like changingVariable/curveLabels: return value = '' and confidence = 0, and add them to 'changingFieldNames'.",
            "3. If a field matches EITHER a 'changingVariable' entry OR the 'curveLabels' quantity OR is a digitization column — no matter whether it varies within each curve (axis) or between curves (series) — it is OFF-LIMITS: always return value = '' and confidence = 0 for that field. This applies with NO exceptions, even if the paper text states a seemingly fixed number for it (e.g. a total duration, an endpoint, or any other scalar) — that field belongs to the varying quantity for this figure and must stay empty here.",
            "3. For all OTHER fields — the FIXED VARIABLES, i.e. fields that do NOT match 'changingVariable' or 'curveLabels' — determine their value normally. Treat the Figure's caption/description as ground truth for this figure's specific condition, and ground the value in the figure metadata or the paper text (e.g. the experimental setup / methods section for conditions shared across figures such as material, oxidant, dosages, etc.).",
            "4. If a fixed-variable field's value truly cannot be determined even from the general experimental setup in the paper, return empty string with confidence 0 rather than guessing.",
            "5. For fields with an 'options' list, only return one of those exact option strings, or empty string if none apply.",
            "6. 'source' should be a short quote or location (e.g. figure caption, section name) that supports the value.",
            "7. CRITICAL — avoid cross-figure contamination: the paper text may contain OTHER sections describing a DIFFERENT figure/panel where some field (e.g. pH, temperature, dosage, concentration, time) is swept across several values (e.g. 'pH = 4, 6, 8, 10'). That sweep belongs ONLY to that other figure, not to this one. Do not borrow one of those swept values for a fixed-variable field here — either return empty string with confidence 0, or use a fixed/default value ONLY if the text explicitly states it applies broadly (e.g. a general experimental conditions caption that lists fixed parameters for a whole figure set, such as '[TC] = 45 µM, T = 28°C unless otherwise noted').",
            "8. Never assume a field takes a value just because numbers for that field exist somewhere in the paper — verify those numbers are actually associated with THIS figure before using them.",
            "9. FALLBACK — 'Paper context' (if provided below) is a pre-built reference table extracted once from the WHOLE paper (so it may contain properties that fall outside the 'Paper text' excerpt given here). It has four parts: 'materials' (catalysts/supports/precursors), 'oxidants', 'micropollutants', and 'generalConditions' (paper-wide default/shared conditions not tied to one specific entity). If a fixed-variable field is still empty after checking 'Paper text', resolve it by LOOKUP ONLY (never infer or compute a new value):",
            "   a. Identify which entity the field belongs to: is it a property of a material/catalyst, of an oxidant, of a micropollutant, or is it a general paper-wide condition?",
            "   b. Identify WHICH specific entity of that type this figure/curve is about (e.g. which catalyst, which oxidant, which micropollutant) — only proceed if that entity is already clear from the figure/curve context; do not guess it.",
            "   c. Look up that exact entity by name in the matching array of 'Paper context' ('materials' / 'oxidants' / 'micropollutants'), or check 'generalConditions' directly if the field is a shared condition rather than tied to one entity.",
            "   d. Copy that entity's matching property value — match by meaning, not exact string (e.g. field 'SBET (catalyst)' matches a materials property named 'BET surface area'; field 'MW (oxidant)' matches an oxidants property named 'MW'; field 'LogKow' matches a micropollutants property of the same name).",
            "   Set 'source' to mention it came from Paper context (e.g. 'Paper context: Cu-rGO LDH (materials), BET surface area'). Do NOT use a property belonging to a DIFFERENT entity than the one this figure/curve is about, and never invent a value that isn't explicitly present in 'Paper context' or 'Paper text'.",
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
            clip(paperText, 15000),
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
            "Paper context (JSON) - reference table of materials/oxidants/micropollutants/generalConditions, built once from the whole paper. Use ONLY as fallback per rule 9 (lookup only, never infer):",
            paperContext
              ? JSON.stringify(paperContext, null, 2)
              : "(none provided)",
          ].join("\n\n"),
        });

        // Debug: confirm whether key characterization terms actually made it
        // into the text sent to the model (not just into the raw paperText).
        {
          const sentText = clip(paperText, 60000);
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
          values: unknown;
          changingFieldNames: string[];
          notes: string;
        };
        const mergedChangingFieldNames = Array.from(
          new Set([...llmResult.changingFieldNames, ...digitizationColumns]),
        );

        return Response.json({
          ...llmResult,
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
