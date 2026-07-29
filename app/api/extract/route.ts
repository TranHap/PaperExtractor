import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { getTextForTask } from "@/lib/paper-sections";

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

async function retryGenerateObject(
  args: Parameters<typeof generateObject>[0],
  retries = 2,
): Promise<{ object: unknown }> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await generateObject({
        maxOutputTokens: 24000, // gpt-4.1-nano: tối đa 32768 completion tokens
        ...args,
        model: MODEL,
      } as Parameters<typeof generateObject>[0]);

      // OpenAI tự động áp dụng prompt caching cho các prompt dài (không cần
      // cấu hình thêm) và trả thông tin cache qua usage.promptTokensDetails
      // .cachedTokens (nếu SDK hỗ trợ). Log lại để tiện kiểm tra.
      const usage = (result as any).usage;
      const cachedTokens = usage?.promptTokensDetails?.cachedTokens;
      if (typeof cachedTokens === "number") {
        console.log("[openai cache]", {
          cachedTokens,
          promptTokens: usage?.promptTokens,
        });
      }

      return { object: (result as { object: unknown }).object };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Nếu do hết token, tăng thêm cho lần retry kế tiếp
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error("Extraction failed after retries");
}

const fieldValueSchema = z.object({
  name: z.string().describe("The exact field name from the schema"),
  value: z.string().describe("Extracted value as a string, or empty string if not found"),
  confidence: z.number().min(0).max(1).describe("Confidence 0-1"),
  source: z.string().describe("Short quote or location supporting the value, or empty string"),
});

function clip(text: string, max = 90000) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n[...truncated...]";
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const task = body.task as string;

    // Trích xuất MỘT LẦN cho cả bài báo (không lặp lại theo từng figure):
    // liệt kê mọi vật liệu được nhắc tới (catalyst, precursor, support, ...)
    // cùng toàn bộ thông số/đặc tính của từng vật liệu (SBET, pHpzc, 2Theta,
    // pore volume, kích thước hạt, thành phần nguyên tố, v.v.), cộng thêm các
    // hằng số/điều kiện chung của cả bài (nếu có). Kết quả này sẽ được front-end
    // lưu lại và truyền sang mỗi lần gọi "figure_extract" để dùng làm nguồn dự
    // phòng khi field không tìm thấy trong text của riêng figure đó.
    if (task === "paper_characteristics") {
      const { paperText } = body as { paperText: string };

      try {
        const { object } = await retryGenerateObject({
          model: MODEL,
          maxOutputTokens: 30000, // gpt-4.1-nano: tối đa 32768 completion tokens
          schema: z.object({
            materials: z.array(
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
                    "EVERY numeric or qualitative characteristic reported for this specific material anywhere in the paper: BET surface area, pore volume, pHpzc, XRD 2Theta / d-spacing, particle/crystallite size, elemental composition (Cu/Mg/Al/C %), degradation rate constant, etc. Do not limit yourself to a fixed list — extract everything found and give each its own entry with a clear 'name'.",
                  ),
              }),
            ),
            generalConstants: z
              .array(fieldValueSchema)
              .describe(
                "Paper-wide default/fixed experimental conditions NOT tied to one specific material — e.g. default reaction temperature, default pollutant concentration, default oxidant dosage, HPLC wavelength, column type, flow rate — ONLY if explicitly stated as a general/shared condition (e.g. in Materials & Methods or a figure caption that says 'unless otherwise noted').",
              ),
            notes: z
              .string()
              .describe(
                "Short summary of coverage / anything ambiguous, or empty string",
              ),
          }),
          prompt: [
            "You are building a COMPLETE reference table of materials and quantitative characteristics mentioned ANYWHERE in this scientific paper.",
            "",
            "INSTRUCTIONS:",
            "1. Scan the ENTIRE paper text: abstract, materials & methods, characterization, results & discussion, conclusion.",
            "2. Identify every distinct material/sample studied (catalysts, precursors, supports, benchmark/comparison materials) by its exact name as used in the paper.",
            "3. For each material, extract EVERY numeric or qualitative property reported for it anywhere in the text: surface area (SBET), pore volume, pHpzc, XRD peak positions / 2Theta / d-spacing, particle or crystallite size, elemental composition (wt% or %), rate constants, activation energy, dosage used, etc. Be exhaustive — do not stop at the first property you find.",
            "4. Also extract general/default experimental constants that apply broadly across the paper (not tied to one material), only if the text explicitly frames them as default/shared conditions.",
            "5. For every value, 'source' must be a short quote or section/figure reference supporting it (e.g. 'Section 3.1, BET surface area 148.69 m2/g').",
            "6. If a property is mentioned only qualitatively (e.g. 'high surface area') without a number, skip it — only extract concrete values.",
            "7. Do not invent or infer values that are not explicitly stated.",
            "",
            "Respond with ONLY valid JSON matching the schema. No markdown, no code fences, no explanation.",
            "",
            "Paper text:",
            clip(paperText, 90000),
          ].join("\n\n"),
        });

        return Response.json(object as Record<string, unknown>);
      } catch (err) {
        console.error("extract/paper_characteristics failed:", err);
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

      try {
        const { object } = await retryGenerateObject({
          model: MODEL,
          schema: z.object({
            figures: z.array(
              z.object({
                label: z.string().describe("e.g. 'Figure 1', 'Fig. 2a'"),
                caption: z
                  .string()
                  .describe(
                    "The figure caption if available, else empty string",
                  ),
                description: z
                  .string()
                  .describe("What the figure shows / plots"),
                xAxis: z
                  .string()
                  .describe("X-axis quantity and unit, or empty string"),
                yAxis: z
                  .string()
                  .describe("Y-axis quantity and unit, or empty string"),
                sweepVariable: z
                  .string()
                  .describe(
                    "The parameter that differs between curveLabels / curves in this figure (i.e. what's swept between series), or empty string. Do NOT put xAxis or yAxis here — this is specifically the between-curve variable.",
                  ),
                curveLabels: z
                  .array(z.string())
                  .describe("Labels of the curves/series shown"),
              }),
            ),
          }),
          prompt: [
            "Build a complete inventory of the FIGURES in this scientific paper.",
            "Scan the text for figure references and captions (Figure/Fig.).",
            "When a figure has distinct labeled panels (a), (b), (c), or (d), list each panel as a separate selectable item with labels such as Figure 4a, Figure 4b, Figure 4c, and Figure 4d whenever the text provides panel-specific information.",
            "Do not collapse panels that have different conditions, variables, axes, curve labels, or plotted quantities. Preserve the panel-specific caption or description for each item.",
            "For each distinct figure, describe what it plots and identify axes and any curve/series labels.",
            "Return them in order.",
            "Respond with ONLY valid JSON matching the schema. No markdown, no code fences, no explanation.",
            "Paper text:",
            clip(paperText),
          ].join("\n\n"),
        });

        // Combine xAxis + yAxis + the between-curve sweep variable into a single
        // 'changingVariable' array. Done here in code (not left to the LLM) so it's
        // deterministic and doesn't cost extra tokens/another model call.
        const rawFigures = (
          object as {
            figures: Array<{
              label: string;
              caption: string;
              description: string;
              xAxis: string;
              yAxis: string;
              sweepVariable: string;
              curveLabels: string[];
            }>;
          }
        ).figures;

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

        return Response.json({ figures });
      } catch (err) {
        console.error("extract/figures failed:", err);
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
        materialsContext,
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
        materialsContext?: unknown;
        xField?: string;
        yField?: string;
        seriesField?: string;
      };
      console.log("figure_extract for:", figure);
      console.log("fields to extract:", fields);
      console.log("materialsContext provided:", !!materialsContext);

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
        const { object } = await retryGenerateObject({
          model: MODEL,
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
              "9. FALLBACK — 'Materials context' (if provided below) is a pre-built reference table of materials and their characteristics, extracted once from the WHOLE paper (so it may contain properties that fall outside the 'Paper text' excerpt given here). If a fixed-variable field is still empty after checking 'Paper text', AND you have already determined which material (e.g. which catalyst) this figure/curve is about, look up that exact material's name in 'Materials context' and use its matching property if one exists — matching by meaning (e.g. field 'SBET (catalyst)' matches a material property named 'BET surface area'). Set 'source' to mention it came from the materials table (e.g. 'Materials context: Cu-rGO LDH, BET surface area'). Do NOT use a property belonging to a DIFFERENT material than the one this figure/curve is about.",
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
             clip(paperText, 60000),
             "Figure (JSON) — the specific figure/panel to extract values for, including its already-determined changingVariable and curveLabels:",
             JSON.stringify(figure, null, 2),
             "Digitization columns:",
             JSON.stringify({
               digitizationXField: xField ?? null,
               digitizationYField: yField ?? null,
               digitizationSeriesField: seriesField ?? null,
             }, null, 2),
             // Đặt SAU 'Figure' (không đặt sớm hơn) vì đây cũng là phần thay đổi
             // theo call/context giống 'Figure', không ảnh hưởng tới cache prefix
             // ổn định của 'Fields' + 'Paper text' phía trên.
             "Materials context (JSON) - reference table of materials and their characteristics, built once from the whole paper. Use ONLY as fallback per rule 9:",
            materialsContext
              ? JSON.stringify(materialsContext, null, 2)
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
        const digitizationColumns = [xField, yField, seriesField]
          .filter((n): n is string => typeof n === "string" && n.trim().length > 0);

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
