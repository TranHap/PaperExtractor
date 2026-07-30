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
  value: string;
  confidence?: number;
  source?: string;
  /** Extraction status: found = AI confirmed value exists, not_found = AI confirmed absence, ambiguous = uncertain */
  status?: "found" | "not_found" | "ambiguous";
  /** For enum fields: how closely the value matches an allowed option */
  matchConfidence?: "exact" | "closest" | "none";
  /** Whether the source quote was verified to fall within the target figure's context */
  sourceVerified?: boolean;
  series?: string;
}

export interface ExperimentContext {
  /** Values for shared fields only */
  values: FieldValue[];
  summary?: string;
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

export type StepId =
  | "schema"
  | "parse"
  | "paper-characteristics"
  | "figures-variables"
  | "figure-values"
  | "digitize"
  | "merge"
  | "dataset";

export interface PaperCharacteristicMaterial {
  name: string;
  role: string;
  values: FieldValue[];
}

export interface PaperCharacteristicsResult {
  materials: PaperCharacteristicMaterial[];
  generalConstants: FieldValue[];
  notes: string;
}

export interface StepMeta {
  id: StepId;
  index: number;
  title: string;
  subtitle: string;
}

export const STEPS: StepMeta[] = [
  {
    id: "schema",
    index: 1,
    title: "Schema",
    subtitle: "Định nghĩa các field cần trích xuất",
  },
  {
    id: "parse",
    index: 2,
    title: "Upload Paper",
    subtitle: "Tải PDF & bóc tách nội dung",
  },
  {
    id: "paper-characteristics",
    index: 3,
    title: "Materials",
    subtitle: "Trích xuất đặc tính vật liệu & hằng số chung",
  },
  {
    id: "figures-variables",
    index: 4,
    title: "Figures & Variables",
    subtitle: "Quét figure và xác định biến thay đổi",
  },
  {
    id: "digitize",
    index: 5,
    title: "Digitize",
    subtitle: "Số hóa điểm dữ liệu",
  },
  {
    id: "figure-values",
    index: 6,
    title: "Fill Values",
    subtitle: "Điền giá trị cho các field còn thiếu của figure",
  },
  {
    id: "merge",
    index: 7,
    title: "Review & Export",
    subtitle: "Hợp nhất mọi ngữ cảnh và xuất dữ liệu",
  },
  { id: "dataset", index: 8, title: "Dataset", subtitle: "Kết quả cuối cùng" },
];
