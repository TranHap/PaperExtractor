export type FieldType = "string" | "number" | "boolean" | "enum";
export type FieldScope = "global" | "per-series";

export type SchemaField = {
  name: string;
  label: string;
  type: "string" | "number" | "select";
  description?: string;
  unit?: string;
  options?: string[];
  scope?: FieldScope;
};

export interface Schema {
  name: string;
  fields: SchemaField[];
}

/** A single extracted value for a schema field */
export interface FieldValue {
  name: string;
  /** Standardized value (in the schema field's declared unit, if any) */
  value: string;
  confidence?: number;
  source?: string;
  /**
   * How this value was established:
   * reported = stated explicitly in the paper/figure; looked_up = not stated
   * in the paper, filled from general chemistry knowledge (only allowed for
   * universal physicochemical constants, never for paper-specific measured
   * data); derived = computed (e.g. unit conversion) from a reported/looked_up
   * value; not_applicable = the concept genuinely doesn't apply to this
   * system (e.g. no catalyst used); not_reported = could not be established.
   */
  provenance?: "reported" | "looked_up" | "derived" | "not_applicable" | "not_reported";
  /** Value + unit exactly as stated in the paper, only set when `value` is a converted/standardized form of it */
  originalValue?: string;
  /** How `value` was obtained from originalValue/looked-up knowledge: formula, exact chemical species, MW used, etc. */
  conversionNote?: string;
  series?: string;
}

export interface VariableField {
  name: string;
  reason: string;
  evidence?: string;
}

export interface FigureItem {
  id: string;
  label: string;
  caption?: string;
  /** What the figure depicts, described by the model */
  description?: string;
  /** X axis quantity + unit, if identifiable from caption */
  xAxis?: string;
  yAxis?: string;
  /** The independent variable being swept in this figure */
  changingVariable?: string[];
  curveLabels?: string[];
}

export interface AxisCalibration {
  /** Two reference points in pixel space and their real values */
  p1: { px: number; py: number; value: number };
  p2: { px: number; py: number; value: number };
  log: boolean;
}

export interface DigitizedPoint {
  /** pixel coords */
  px: number;
  py: number;
  /** real world coords after calibration */
  x: number;
  y: number;
  /** curve/series this point belongs to */
  series: string;
}

export interface Digitization {
  imageUrl: string;
  xCal?: AxisCalibration;
  yCal?: AxisCalibration;
  points: DigitizedPoint[];
  series: string[];
  activeSeries: string;
}

export interface FigureContext {
  values: FieldValue[];
  curveLabels: string[];
  changingVariable: string[];
  changingFieldNames?: string[]; // 👈 thêm dòng này
  notes: string;
}

export interface ScopeDecision {
  name: string;
  scope: "global" | "per-series";
  reason?: string;
}

export interface Dataset {
  schemaName: string;
  paperTitle?: string;
  figure: FigureItem | null;
  merged: FieldValue[];
  points: DigitizedPoint[];
  xField?: string;
  yField?: string;
  seriesField?: string;
  generatedAt: string;
}

/** Every figure processed so far for one paper, combined into a single export. */
export interface PaperDataset {
  schemaName: string;
  paperTitle?: string;
  generatedAt: string;
  figures: Dataset[];
}

export type StepId =
  | "parse"
  | "schema"
  | "paper-characteristics"
  | "figures-variables"
  | "digitize"
  | "fill-values"
  | "merge"
  | "dataset";

export interface PaperCharacteristicMaterial {
  name: string;
  role: string;
  values: FieldValue[];
}

export interface PaperCharacteristicEntity {
  name: string;
  values: FieldValue[];
}

export interface PaperCharacteristicsResult {
  materials: PaperCharacteristicMaterial[];
  oxidants: PaperCharacteristicEntity[];
  micropollutants: PaperCharacteristicEntity[];
  generalConditions: FieldValue[];
  notes: string;
}

/**
 * Which part of the pipeline a step belongs to, used by the Stepper to group
 * steps visually:
 * - "setup"  — done ONCE per paper (upload, define schema, extract materials).
 * - "figure" — repeated ONCE PER FIGURE (select figure, digitize + fill
 *   values, review) — this is a loop in practice, not a linear sequence; the
 *   Dataset step lets the user jump straight back into "figure" steps for
 *   the next/another figure instead of walking through "setup" again.
 * - "export" — final combined output for the whole paper.
 */
export type StepPhase = "setup" | "figure" | "export";

export interface StepMeta {
  id: StepId;
  index: number;
  title: string;
  subtitle: string;
  phase: StepPhase;
}

export const STEPS: StepMeta[] = [
  {
    id: "parse",
    index: 1,
    title: "Upload Paper",
    subtitle: "Tải PDF & bóc tách nội dung",
    phase: "setup",
  },
  {
    id: "schema",
    index: 2,
    title: "Schema",
    subtitle: "Định nghĩa các field cần trích xuất",
    phase: "setup",
  },
  {
    id: "paper-characteristics",
    index: 3,
    title: "Materials",
    subtitle: "Trích xuất đặc tính vật liệu & hằng số chung",
    phase: "setup",
  },
  {
    id: "figures-variables",
    index: 4,
    title: "Figures & Variables",
    subtitle: "Quét figure và xác định biến thay đổi",
    phase: "figure",
  },
  {
    id: "digitize",
    index: 5,
    title: "Digitize",
    subtitle: "Hiệu chỉnh trục và số hóa điểm dữ liệu cho figure này",
    phase: "figure",
  },
  {
    id: "fill-values",
    index: 6,
    title: "Fill Values",
    subtitle: "Điền giá trị các field còn thiếu cho figure này",
    phase: "figure",
  },
  {
    id: "merge",
    index: 7,
    title: "Review",
    subtitle: "Hợp nhất ngữ cảnh của figure này trước khi gộp vào dataset",
    phase: "figure",
  },
  {
    id: "dataset",
    index: 8,
    title: "Dataset",
    subtitle: "Toàn bộ figure đã số hóa của paper — xuất 1 file tổng",
    phase: "export",
  },
];
