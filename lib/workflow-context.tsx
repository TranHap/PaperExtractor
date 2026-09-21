"use client";

import type React from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type Digitization,
  type FigureContext,
  type FigureItem,
  type PaperCharacteristicsResult,
  type Schema,
  type VariableField,
  STEPS,
  type StepId,
} from "@/lib/types";
import {
  chunkText,
  clip,
  mapWithConcurrency,
  mergeEntityLists,
  PAPER_CONTEXT_CHUNK_OVERLAP,
  PAPER_CONTEXT_CHUNK_SIZE,
  PAPER_CONTEXT_MAX_CONCURRENT_CHUNKS,
  PAPER_CONTEXT_MAX_TOTAL_CHARS,
  type EntityNames,
  type PaperContextChunkResult,
} from "@/lib/paper-context";

export interface ParsedPaper {
  fileName: string;
  title?: string;
  text: string;
  pages: number;
  /** Extracted text for each page, used to locate a selected figure. */
  pageTexts: string[];
  /** data-url images, one per page */
  pageImages: string[];
}

interface WorkflowState {
  currentStep: StepId;
  setCurrentStep: (s: StepId) => void;
  goNext: () => void;
  goBack: () => void;
  reset: () => void;

  schema: Schema | null;
  setSchema: (s: Schema | null) => void;

  variableFields: VariableField[];
  setVariableFields: (fields: VariableField[]) => void;

  xField: string;
  setXField: (field: string) => void;
  yField: string;
  setYField: (field: string) => void;
  seriesField: string;
  setSeriesField: (field: string) => void;

  paper: ParsedPaper | null;
  setPaper: (p: ParsedPaper | null) => void;

  /**
   * Short citation-style label for this paper (e.g. "YongFengEST 2016"),
   * used as the CSV "Source" column instead of the full paper title —
   * something like `paper.title` is too long/inconsistent for that (varies
   * with how the publisher's PDF metadata happens to be set) and there's no
   * reliable way to auto-derive an author+year citekey from PDF text, so
   * this is entered by hand once per paper. Empty means "not set yet";
   * DatasetStep falls back to the paper title/filename in that case.
   */
  citationLabel: string;
  setCitationLabel: (label: string) => void;

  figures: FigureItem[];
  setFigures: (f: FigureItem[]) => void;

  selectedFigure: FigureItem | null;
  setSelectedFigure: (f: FigureItem | null) => void;

  digitization: Digitization | null;
  setDigitization: (d: Digitization | null) => void;

  digitizationByFigure: Record<string, Digitization>;
  setDigitizationByFigure: (d: Record<string, Digitization>) => void;

  /**
   * The CURRENT figure's extracted values + metadata. This is the single
   * source of truth for "what values does this figure have" — there used to
   * be a second, parallel `resolvedContext` state that duplicated the same
   * data (re-derived from this one via `buildMerged`), kept in sync by hand
   * across every step. That duplication was a real bug source: `figureContext`
   * wasn't always restored when switching figures, so a stale figure's values
   * could leak into another figure's Review step. Don't reintroduce a second
   * copy — components that need schema-ordered values should derive them
   * on the fly with `buildMerged(schema, [], figureContext.values)`.
   */
  figureContext: FigureContext | null;
  setFigureContext: (c: FigureContext | null) => void;

  figureContextByFigure: Record<string, FigureContext>;
  setFigureContextByFigure: (c: Record<string, FigureContext>) => void;

  paperCharacteristics: PaperCharacteristicsResult | null;
  setPaperCharacteristics: (v: PaperCharacteristicsResult | null) => void;

  /**
   * The "Materials" scan (paper_context_names + paper_context_chunk calls)
   * used to live entirely inside PaperCharacteristicsStep's own useState —
   * which meant navigating to another step (nothing stops that; the Stepper
   * has no gating) unmounted the component, and a second visit to Materials
   * re-triggered a full second scan on top of whatever was still in flight,
   * silently racing two sets of network calls against the same
   * setPaperCharacteristics. Owning the scan here instead — a single
   * instance shared through context regardless of which step is mounted —
   * lets the user leave for Figures/Digitize while it keeps running, see its
   * progress from anywhere, and come back to a finished (or still-running)
   * result instead of a duplicate scan.
   */
  paperCharacteristicsStatus: "idle" | "running" | "done" | "error";
  paperCharacteristicsProgress: { done: number; total: number } | null;
  paperCharacteristicsError: string | null;
  paperCharacteristicsWarning: string | null;
  runPaperCharacteristicsScan: (paper: ParsedPaper, schema: Schema | null) => void;
}

const Ctx = createContext<WorkflowState | null>(null);

const ORDER = STEPS.map((s) => s.id);

const STORAGE_KEY = "sde:workflow-state-v3";

type PersistedState = {
  currentStep: StepId;
  schema: Schema | null;
  variableFields: VariableField[];
  xField: string;
  yField: string;
  seriesField: string;
  paper: ParsedPaper | null;
  citationLabel: string;
  figures: FigureItem[];
  selectedFigure: FigureItem | null;
  digitization: Digitization | null;
  digitizationByFigure: Record<string, Digitization>;
  figureContext: FigureContext | null;
  figureContextByFigure: Record<string, FigureContext>;
  paperCharacteristics: PaperCharacteristicsResult | null;
};

function loadPersisted(): Partial<PersistedState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(state: PersistedState) {
  try {
    const payload: PersistedState = {
      ...state,
      paper: state.paper
        ? {
            ...state.paper,
            pageImages: [],
          }
        : null,
      digitization: state.digitization
        ? {
            ...state.digitization,
            imageUrl: "",
          }
        : null,
      // Same reason as `digitization.imageUrl` above — each entry here also
      // carries a full page-image data URL (hundreds of KB to a few MB).
      // Missing this meant every figure ever digitized stayed in the
      // persisted payload at full size, so a single keystroke anywhere that
      // touches `digitizationByFigure` (e.g. renaming a series) re-serialized
      // and wrote several figures' worth of image data to localStorage on
      // EVERY keystroke — the actual cause of the Digitize step feeling
      // laggy/unresponsive while typing.
      digitizationByFigure: Object.fromEntries(
        Object.entries(state.digitizationByFigure).map(([id, d]) => [
          id,
          { ...d, imageUrl: "" },
        ]),
      ),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota/errors
  }
}

export function WorkflowProvider({ children }: { children: React.ReactNode }) {
  const hydrated = useRef(false);
  const initial = loadPersisted();
  // Seeded from the persisted paper (if any) so the restore effect below
  // doesn't mistake "reloading with a paper already loaded" for "a new
  // paper was just uploaded" and wipe every figure's digitized work.
  const previousPaperFile = useRef<string | null>(initial?.paper?.fileName ?? null);
  const [loaded, setLoaded] = useState(false);

  const [currentStep, setCurrentStep] = useState<StepId>("parse");
  const [schema, setSchema] = useState<Schema | null>(null);
  const [variableFields, setVariableFields] = useState<VariableField[]>([]);
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [seriesField, setSeriesField] = useState("");
  const [paper, setPaper] = useState<ParsedPaper | null>(null);
  const [citationLabel, setCitationLabel] = useState("");
  const [figures, setFigures] = useState<FigureItem[]>([]);
  const [selectedFigure, setSelectedFigure] = useState<FigureItem | null>(null);
  const [digitization, setDigitization] = useState<Digitization | null>(null);
  const [digitizationByFigure, setDigitizationByFigure] = useState<Record<string, Digitization>>({});
  const [figureContext, setFigureContext] = useState<FigureContext | null>(null);
  const [figureContextByFigure, setFigureContextByFigure] = useState<Record<string, FigureContext>>({});
  const [paperCharacteristics, setPaperCharacteristics] = useState<PaperCharacteristicsResult | null>(null);

  const [paperCharacteristicsStatus, setPaperCharacteristicsStatus] = useState<
    "idle" | "running" | "done" | "error"
  >("idle");
  const [paperCharacteristicsProgress, setPaperCharacteristicsProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [paperCharacteristicsError, setPaperCharacteristicsError] = useState<string | null>(null);
  const [paperCharacteristicsWarning, setPaperCharacteristicsWarning] = useState<string | null>(null);
  // Guards against firing a second scan while one is already in flight — a
  // ref (not state) because it has to be read synchronously at call time,
  // before any re-render, to actually block a rapid double-click/re-mount.
  const paperCharacteristicsRunning = useRef(false);
  // Bumped whenever the paper changes (see the hydration effect below) so a
  // scan started for a PREVIOUS paper that's still finishing in the
  // background (fetches aren't cancelled — nothing here aborts them) can
  // detect it's stale and drop its results instead of overwriting the new
  // paper's (empty) paperCharacteristics with the old paper's data.
  const paperCharacteristicsGeneration = useRef(0);

  async function postExtractForScan(body: Record<string, unknown>): Promise<any> {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error(
        `Server returned non-JSON response (status ${res.status}). This usually means the request timed out on the server. Please try again with a shorter paper, or contact support if the problem persists.`,
      );
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Trích xuất thất bại");
    return data;
  }

  // Drives the paper_context scan chunk-by-chunk from the BROWSER (see
  // lib/paper-context.ts for why: Netlify's ~30s server-side timeout).
  // Lives on the provider — not inside PaperCharacteristicsStep — precisely
  // so it keeps running (and keeps updating shared `paperCharacteristics`
  // state) no matter which step the user navigates to while it's in flight.
  function runPaperCharacteristicsScan(paperArg: ParsedPaper, schemaArg: Schema | null) {
    if (paperCharacteristicsRunning.current) return; // already running — don't double-fire
    paperCharacteristicsRunning.current = true;
    const myGeneration = paperCharacteristicsGeneration.current;
    setPaperCharacteristicsStatus("running");
    setPaperCharacteristicsError(null);
    setPaperCharacteristicsWarning(null);
    setPaperCharacteristicsProgress(null);

    (async () => {
      try {
        const clippedText = clip(paperArg.text, PAPER_CONTEXT_MAX_TOTAL_CHARS);
        const fields = (schemaArg?.fields ?? []).map((f) => ({
          name: f.name,
          description: f.description,
          unit: f.unit,
        }));

        let knownEntities: EntityNames = {
          materials: [],
          oxidants: [],
          micropollutants: [],
        };
        try {
          knownEntities = await postExtractForScan({
            task: "paper_context_names",
            paperText: clippedText,
          });
        } catch (e) {
          // Best-effort consistency aid, not a hard requirement — if it
          // fails, chunks below still work, just with a slightly higher
          // chance of naming the same entity differently in two chunks.
          console.error("paper_context_names failed (continuing without it):", e);
        }

        const chunks = chunkText(clippedText, PAPER_CONTEXT_CHUNK_SIZE, PAPER_CONTEXT_CHUNK_OVERLAP);
        let done = 0;
        let chunkFailures = 0;
        setPaperCharacteristicsProgress({ done: 0, total: chunks.length });

        const chunkResults = await mapWithConcurrency(
          chunks,
          PAPER_CONTEXT_MAX_CONCURRENT_CHUNKS,
          async (chunkOfText, index): Promise<PaperContextChunkResult> => {
            try {
              const data = await postExtractForScan({
                task: "paper_context_chunk",
                chunkText: chunkOfText,
                chunkIndex: index,
                totalChunks: chunks.length,
                knownEntities,
                fields,
              });
              return {
                materials: data.materials ?? [],
                oxidants: data.oxidants ?? [],
                micropollutants: data.micropollutants ?? [],
                notes: data.notes ?? "",
              };
            } catch (e) {
              chunkFailures++;
              console.error(`paper_context_chunk ${index} failed:`, e);
              return {
                materials: [],
                oxidants: [],
                micropollutants: [],
                notes: "",
              };
            } finally {
              done++;
              setPaperCharacteristicsProgress({ done, total: chunks.length });
            }
          },
        );

        const materials = mergeEntityLists(chunkResults.flatMap((r) => r.materials ?? []));
        const oxidants = mergeEntityLists(chunkResults.flatMap((r) => r.oxidants ?? []));
        const micropollutants = mergeEntityLists(chunkResults.flatMap((r) => r.micropollutants ?? []));
        const notes = chunkResults
          .map((r) => r.notes?.trim())
          .filter((n): n is string => Boolean(n))
          .join(" ");

        if (myGeneration !== paperCharacteristicsGeneration.current) return; // stale — paper changed mid-scan
        setPaperCharacteristics({ materials, oxidants, micropollutants, notes });
        setPaperCharacteristicsStatus("done");
        if (chunkFailures > 0) {
          setPaperCharacteristicsWarning(
            `${chunkFailures}/${chunks.length} đoạn của paper quét chưa xong (mạng/model chậm) — dữ liệu có thể thiếu một phần. Bấm "Quét lại" để thử lại phần còn thiếu.`,
          );
        }
      } catch (e) {
        if (myGeneration === paperCharacteristicsGeneration.current) {
          setPaperCharacteristicsStatus("error");
          setPaperCharacteristicsError(e instanceof Error ? e.message : "Có lỗi xảy ra");
        }
      } finally {
        if (myGeneration === paperCharacteristicsGeneration.current) {
          setPaperCharacteristicsProgress(null);
          paperCharacteristicsRunning.current = false;
        }
      }
    })();
  }

  useEffect(() => {
    if (!loaded && initial) {
      setCurrentStep(initial.currentStep ?? "parse");
      setSchema(initial.schema ?? null);
      setVariableFields(initial.variableFields ?? []);
      setXField(initial.xField ?? "");
      setYField(initial.yField ?? "");
      setSeriesField(initial.seriesField ?? "");
      setPaper(initial.paper ?? null);
      setCitationLabel(initial.citationLabel ?? "");
      setFigures(initial.figures ?? []);
      setSelectedFigure(initial.selectedFigure ?? null);
      setDigitization(initial.digitization ?? null);
      setDigitizationByFigure(initial.digitizationByFigure ?? {});
      setFigureContext(initial.figureContext ?? null);
      setFigureContextByFigure(initial.figureContextByFigure ?? {});
      setPaperCharacteristics(initial.paperCharacteristics ?? null);
      setLoaded(true);
    }
  }, [loaded, initial]);

  useEffect(() => {
    if (!hydrated.current) {
      // First commit: state is still the pre-restore defaults (the load
      // effect above hasn't applied yet). previousPaperFile is already
      // seeded from persisted state at ref-init time — don't clobber it
      // with the default (null) `paper` here.
      hydrated.current = true;
      return;
    }
    if (paper?.fileName && paper.fileName !== previousPaperFile.current) {
      previousPaperFile.current = paper.fileName;
      setCitationLabel("");
      setFigures([]);
      setSelectedFigure(null);
      setVariableFields([]);
      setDigitization(null);
      setDigitizationByFigure({});
      setFigureContext(null);
      setFigureContextByFigure({});
      setPaperCharacteristics(null);
      paperCharacteristicsGeneration.current++;
      paperCharacteristicsRunning.current = false;
      setPaperCharacteristicsStatus("idle");
      setPaperCharacteristicsProgress(null);
      setPaperCharacteristicsError(null);
      setPaperCharacteristicsWarning(null);
    }
    persist({
      currentStep,
      schema,
      variableFields,
      xField,
      yField,
      seriesField,
      paper,
      citationLabel,
      figures,
      selectedFigure,
      digitization,
      digitizationByFigure,
      figureContext,
      figureContextByFigure,
      paperCharacteristics,
    });
  }, [
    loaded,
    currentStep,
    schema,
    variableFields,
    xField,
    yField,
    seriesField,
    paper,
    citationLabel,
    figures,
    selectedFigure,
    digitization,
    digitizationByFigure,
    figureContext,
    figureContextByFigure,
    paperCharacteristics,
  ]);

  const value = useMemo<WorkflowState>(() => {
    const goNext = () => {
      const i = ORDER.indexOf(currentStep);
      if (i < ORDER.length - 1) setCurrentStep(ORDER[i + 1]);
    };
    const goBack = () => {
      const i = ORDER.indexOf(currentStep);
      if (i > 0) setCurrentStep(ORDER[i - 1]);
    };
    const reset = () => {
      setSchema(null);
      setVariableFields([]);
      setXField("");
      setYField("");
      setSeriesField("");
      setPaper(null);
      setCitationLabel("");
      setFigures([]);
      setSelectedFigure(null);
      setDigitization(null);
      setDigitizationByFigure({});
      setFigureContext(null);
      setFigureContextByFigure({});
      setPaperCharacteristics(null);
      paperCharacteristicsGeneration.current++;
      paperCharacteristicsRunning.current = false;
      setPaperCharacteristicsStatus("idle");
      setPaperCharacteristicsProgress(null);
      setPaperCharacteristicsError(null);
      setPaperCharacteristicsWarning(null);
      setCurrentStep("parse");
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    };
    return {
      currentStep,
      setCurrentStep,
      goNext,
      goBack,
      reset,
      schema,
      setSchema,
      variableFields,
      setVariableFields,
      xField,
      setXField,
      yField,
      setYField,
      seriesField,
      setSeriesField,
      paper,
      setPaper,
      citationLabel,
      setCitationLabel,
      figures,
      setFigures,
      selectedFigure,
      setSelectedFigure,
      digitization,
      setDigitization,
      digitizationByFigure,
      setDigitizationByFigure,
      figureContext,
      setFigureContext,
      figureContextByFigure,
      setFigureContextByFigure,
      paperCharacteristics,
      setPaperCharacteristics,
      paperCharacteristicsStatus,
      paperCharacteristicsProgress,
      paperCharacteristicsError,
      paperCharacteristicsWarning,
      runPaperCharacteristicsScan,
    };
  }, [
    loaded,
    currentStep,
    schema,
    variableFields,
    xField,
    yField,
    seriesField,
    paper,
    citationLabel,
    figures,
    selectedFigure,
    digitization,
    digitizationByFigure,
    figureContext,
    figureContextByFigure,
    paperCharacteristics,
    paperCharacteristicsStatus,
    paperCharacteristicsProgress,
    paperCharacteristicsError,
    paperCharacteristicsWarning,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkflow() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkflow must be used within WorkflowProvider");
  return ctx;
}
