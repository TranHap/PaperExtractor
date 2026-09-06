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

  figures: FigureItem[];
  setFigures: (f: FigureItem[]) => void;

  selectedFigure: FigureItem | null;
  setSelectedFigure: (f: FigureItem | null) => void;

  digitization: Digitization | null;
  setDigitization: (d: Digitization | null) => void;

  digitizationByFigure: Record<string, Digitization>;
  setDigitizationByFigure: (d: Record<string, Digitization>) => void;

  /**
   * Figure ids the user has already exported from the Dataset step. Once a
   * figure has been downloaded, it's excluded from the combined dataset so
   * moving on to digitize the next figure doesn't re-merge work that was
   * already saved. The user can pull them back in from the Dataset step.
   */
  exportedFigureIds: string[];
  setExportedFigureIds: (ids: string[]) => void;

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
  figures: FigureItem[];
  selectedFigure: FigureItem | null;
  digitization: Digitization | null;
  digitizationByFigure: Record<string, Digitization>;
  exportedFigureIds: string[];
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
  const [figures, setFigures] = useState<FigureItem[]>([]);
  const [selectedFigure, setSelectedFigure] = useState<FigureItem | null>(null);
  const [digitization, setDigitization] = useState<Digitization | null>(null);
  const [digitizationByFigure, setDigitizationByFigure] = useState<Record<string, Digitization>>({});
  const [exportedFigureIds, setExportedFigureIds] = useState<string[]>([]);
  const [figureContext, setFigureContext] = useState<FigureContext | null>(null);
  const [figureContextByFigure, setFigureContextByFigure] = useState<Record<string, FigureContext>>({});
  const [paperCharacteristics, setPaperCharacteristics] = useState<PaperCharacteristicsResult | null>(null);

  useEffect(() => {
    if (!loaded && initial) {
      setCurrentStep(initial.currentStep ?? "parse");
      setSchema(initial.schema ?? null);
      setVariableFields(initial.variableFields ?? []);
      setXField(initial.xField ?? "");
      setYField(initial.yField ?? "");
      setSeriesField(initial.seriesField ?? "");
      setPaper(initial.paper ?? null);
      setFigures(initial.figures ?? []);
      setSelectedFigure(initial.selectedFigure ?? null);
      setDigitization(initial.digitization ?? null);
      setDigitizationByFigure(initial.digitizationByFigure ?? {});
      setExportedFigureIds(initial.exportedFigureIds ?? []);
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
      setFigures([]);
      setSelectedFigure(null);
      setVariableFields([]);
      setDigitization(null);
      setDigitizationByFigure({});
      setExportedFigureIds([]);
      setFigureContext(null);
      setFigureContextByFigure({});
      setPaperCharacteristics(null);
    }
    persist({
      currentStep,
      schema,
      variableFields,
      xField,
      yField,
      seriesField,
      paper,
      figures,
      selectedFigure,
      digitization,
      digitizationByFigure,
      exportedFigureIds,
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
    figures,
    selectedFigure,
    digitization,
    digitizationByFigure,
    exportedFigureIds,
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
      setFigures([]);
      setSelectedFigure(null);
      setDigitization(null);
      setDigitizationByFigure({});
      setExportedFigureIds([]);
      setFigureContext(null);
      setFigureContextByFigure({});
      setPaperCharacteristics(null);
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
      figures,
      setFigures,
      selectedFigure,
      setSelectedFigure,
      digitization,
      setDigitization,
      digitizationByFigure,
      setDigitizationByFigure,
      exportedFigureIds,
      setExportedFigureIds,
      figureContext,
      setFigureContext,
      figureContextByFigure,
      setFigureContextByFigure,
      paperCharacteristics,
      setPaperCharacteristics,
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
    figures,
    selectedFigure,
    digitization,
    digitizationByFigure,
    exportedFigureIds,
    figureContext,
    figureContextByFigure,
    paperCharacteristics,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkflow() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkflow must be used within WorkflowProvider");
  return ctx;
}
