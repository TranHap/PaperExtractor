"use client";

import type React from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type Digitization,
  type ExperimentContext,
  type FieldValue,
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

  experiment: ExperimentContext | null;
  setExperiment: (e: ExperimentContext | null) => void;

  figures: FigureItem[];
  setFigures: (f: FigureItem[]) => void;

  selectedFigure: FigureItem | null;
  setSelectedFigure: (f: FigureItem | null) => void;

  resolvedContext: FieldValue[] | null;
  setResolvedContext: (v: FieldValue[] | null) => void;

  resolvedContextByFigure: Record<string, FieldValue[]>;
  setResolvedContextByFigure: (v: Record<string, FieldValue[]>) => void;

  digitization: Digitization | null;
  setDigitization: (d: Digitization | null) => void;

  digitizationByFigure: Record<string, Digitization>;
  setDigitizationByFigure: (d: Record<string, Digitization>) => void;

  figureContext: FigureContext | null;
  setFigureContext: (c: FigureContext | null) => void;

  figureContextByFigure: Record<string, FigureContext>;
  setFigureContextByFigure: (c: Record<string, FigureContext>) => void;

  imageParamsContext: FieldValue[] | null;
  setImageParamsContext: (v: FieldValue[] | null) => void;

  imageParamsContextByFigure: Record<string, FieldValue[]>;
  setImageParamsContextByFigure: (v: Record<string, FieldValue[]>) => void;

  exportedFigureIds: string[];
  setExportedFigureIds: (ids: string[]) => void;

  paperCharacteristics: PaperCharacteristicsResult | null;
  setPaperCharacteristics: (v: PaperCharacteristicsResult | null) => void;
}

const Ctx = createContext<WorkflowState | null>(null);

const ORDER = STEPS.map((s) => s.id);

const STORAGE_KEY = "sde:workflow-state-v1";

type PersistedState = {
  currentStep: StepId;
  schema: Schema | null;
  variableFields: VariableField[];
  xField: string;
  yField: string;
  seriesField: string;
  paper: ParsedPaper | null;
  experiment: ExperimentContext | null;
  figures: FigureItem[];
  selectedFigure: FigureItem | null;
  resolvedContext: FieldValue[] | null;
  resolvedContextByFigure: Record<string, FieldValue[]>;
  digitization: Digitization | null;
  digitizationByFigure: Record<string, Digitization>;
  figureContext: FigureContext | null;
  figureContextByFigure: Record<string, FigureContext>;
  imageParamsContext: FieldValue[] | null;
  imageParamsContextByFigure: Record<string, FieldValue[]>;
  exportedFigureIds: string[];
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
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota/errors
  }
}

export function WorkflowProvider({ children }: { children: React.ReactNode }) {
  const hydrated = useRef(false);
  const previousPaperFile = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const initial = loadPersisted();

  const [currentStep, setCurrentStep] = useState<StepId>("schema");
  const [schema, setSchema] = useState<Schema | null>(null);
  const [variableFields, setVariableFields] = useState<VariableField[]>([]);
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [seriesField, setSeriesField] = useState("");
  const [paper, setPaper] = useState<ParsedPaper | null>(null);
  const [experiment, setExperiment] = useState<ExperimentContext | null>(null);
  const [figures, setFigures] = useState<FigureItem[]>([]);
  const [selectedFigure, setSelectedFigure] = useState<FigureItem | null>(null);
  const [resolvedContext, setResolvedContext] = useState<FieldValue[] | null>(null);
  const [resolvedContextByFigure, setResolvedContextByFigure] = useState<Record<string, FieldValue[]>>({});
  const [digitization, setDigitization] = useState<Digitization | null>(null);
  const [digitizationByFigure, setDigitizationByFigure] = useState<Record<string, Digitization>>({});
  const [figureContext, setFigureContext] = useState<FigureContext | null>(null);
  const [figureContextByFigure, setFigureContextByFigure] = useState<Record<string, FigureContext>>({});
  const [imageParamsContext, setImageParamsContext] = useState<FieldValue[] | null>(null);
  const [imageParamsContextByFigure, setImageParamsContextByFigure] = useState<Record<string, FieldValue[]>>({});
  const [exportedFigureIds, setExportedFigureIds] = useState<string[]>([]);
  const [paperCharacteristics, setPaperCharacteristics] = useState<PaperCharacteristicsResult | null>(null);

  useEffect(() => {
    if (!loaded && initial) {
      setCurrentStep(initial.currentStep ?? "schema");
      setSchema(initial.schema ?? null);
      setVariableFields(initial.variableFields ?? []);
      setXField(initial.xField ?? "");
      setYField(initial.yField ?? "");
      setSeriesField(initial.seriesField ?? "");
      setPaper(initial.paper ?? null);
      setExperiment(initial.experiment ?? null);
      setFigures(initial.figures ?? []);
      setSelectedFigure(initial.selectedFigure ?? null);
      setResolvedContext(initial.resolvedContext ?? null);
      setResolvedContextByFigure(initial.resolvedContextByFigure ?? {});
      setDigitization(initial.digitization ?? null);
      setDigitizationByFigure(initial.digitizationByFigure ?? {});
      setFigureContext(initial.figureContext ?? null);
      setFigureContextByFigure(initial.figureContextByFigure ?? {});
      setImageParamsContext(initial.imageParamsContext ?? null);
      setImageParamsContextByFigure(initial.imageParamsContextByFigure ?? {});
      setExportedFigureIds(initial.exportedFigureIds ?? []);
      setPaperCharacteristics(initial.paperCharacteristics ?? null);
      setLoaded(true);
    }
  }, [loaded, initial]);

  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      previousPaperFile.current = paper?.fileName ?? null;
      return;
    }
    if (paper?.fileName && paper.fileName !== previousPaperFile.current) {
      previousPaperFile.current = paper.fileName;
      setExperiment(null);
      setFigures([]);
      setSelectedFigure(null);
      setVariableFields([]);
      setResolvedContext(null);
      setResolvedContextByFigure({});
      setDigitization(null);
      setDigitizationByFigure({});
      setFigureContext(null);
      setFigureContextByFigure({});
      setExportedFigureIds([]);
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
      experiment,
      figures,
      selectedFigure,
      resolvedContext,
      resolvedContextByFigure,
      digitization,
      digitizationByFigure,
      figureContext,
      figureContextByFigure,
      imageParamsContext,
      imageParamsContextByFigure,
      exportedFigureIds,
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
    experiment,
    figures,
    selectedFigure,
    resolvedContext,
    digitization,
    figureContext,
    imageParamsContext,
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
      setExperiment(null);
      setFigures([]);
      setSelectedFigure(null);
      setResolvedContext(null);
      setResolvedContextByFigure({});
      setDigitization(null);
      setDigitizationByFigure({});
      setFigureContext(null);
      setFigureContextByFigure({});
      setImageParamsContext(null);
      setImageParamsContextByFigure({});
      setExportedFigureIds([]);
      setPaperCharacteristics(null);
      setCurrentStep("schema");
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
      experiment,
      setExperiment,
      figures,
      setFigures,
      selectedFigure,
      setSelectedFigure,
      resolvedContext,
      setResolvedContext,
      resolvedContextByFigure,
      setResolvedContextByFigure,
      digitization,
      setDigitization,
      digitizationByFigure,
      setDigitizationByFigure,
      figureContext,
      setFigureContext,
      figureContextByFigure,
      setFigureContextByFigure,
      imageParamsContext,
      setImageParamsContext,
      imageParamsContextByFigure,
      setImageParamsContextByFigure,
      exportedFigureIds,
      setExportedFigureIds,
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
    experiment,
    figures,
    selectedFigure,
    resolvedContext,
    resolvedContextByFigure,
    digitization,
    digitizationByFigure,
    figureContext,
    figureContextByFigure,
    imageParamsContext,
    imageParamsContextByFigure,
    exportedFigureIds,
    paperCharacteristics,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkflow() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkflow must be used within WorkflowProvider");
  return ctx;
}
