"use client";

import { type ReactNode, useState } from "react";
import {
  Loader2,
  ScanSearch,
  AlertCircle,
  FlaskConical,
  BookOpen,
  Search,
} from "lucide-react";
import { StepShell } from "@/components/step-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProvenanceBadge } from "@/components/values-editor";
import { useWorkflow } from "@/lib/workflow-context";
import type {
  FieldValue,
  PaperCharacteristicEntity,
  PaperCharacteristicMaterial,
} from "@/lib/types";
import type { LserdRow } from "@/app/api/lserd/route";
import { searchPubchem, type PubchemBasic, type PubchemPkaCandidate } from "@/lib/pubchem";
import { stripParenthetical } from "@/lib/chem-name";

// Shared by every external-lookup "apply" handler below (LSERD, PubChem):
// replaces the field by name if it already exists, otherwise appends it —
// same convention regardless of which external source supplied the value.
function upsertField(
  values: FieldValue[],
  update: { name: string; value: string; source: string; conversionNote?: string },
): FieldValue[] {
  const next: FieldValue = {
    confidence: 1,
    provenance: "looked_up",
    originalValue: undefined,
    ...update,
  };
  const idx = values.findIndex((v) => v.name === update.name);
  if (idx >= 0) {
    const copy = [...values];
    copy[idx] = next;
    return copy;
  }
  return [...values, next];
}

// Abraham solvation parameters (E, S, A, B, V) for a micropollutant are
// almost never stated in the paper itself — they come from an external
// reference database (UFZ LSERD, see app/api/lserd/route.ts). Several
// literature sources usually exist for the same compound with slightly
// different regressed values, so this is a manual pick from search results
// rather than an auto-fill: the user searches by compound name and chooses
// which row's E/S/A/B/V to keep.
const LSERD_FIELD_NAMES = ["E", "S", "A", "B", "V"] as const;

function upsertLserdRow(values: FieldValue[], row: LserdRow): FieldValue[] {
  const source = `LSERD${row.shortCite ? `: ${row.shortCite}` : ""}`;
  let next = values;
  for (const name of LSERD_FIELD_NAMES) {
    const value = row[name];
    if (!value || value === "-") continue;
    next = upsertField(next, { name, value, source, conversionNote: row.citation || undefined });
  }
  return next;
}

// MW/LogKow(XLogP)/TPSA come back from PubChem as clean single values, so
// they're applied together in one shot. pKa has no structured field in
// PubChem — only free-text experimental annotations, often several per
// compound from different sources — so it's applied separately, one
// candidate at a time, after the user reads and picks one (see
// lib/pubchem.ts for why).
function upsertPubchemBasic(values: FieldValue[], basic: PubchemBasic): FieldValue[] {
  const source = `PubChem CID ${basic.cid}${basic.name ? ` (${basic.name})` : ""}`;
  let next = values;
  for (const [name, value] of [
    ["MW", basic.MW],
    ["LogKow", basic.LogKow],
    ["TPSA", basic.TPSA],
  ] as const) {
    if (!value) continue;
    next = upsertField(next, { name, value, source });
  }
  return next;
}

function upsertPubchemPka(values: FieldValue[], candidate: PubchemPkaCandidate): FieldValue[] {
  return upsertField(values, {
    name: "pKa",
    value: candidate.value,
    source: `PubChem: ${candidate.source}`,
  });
}

function LserdLookup({ entityName, onApply }: { entityName: string; onApply: (row: LserdRow) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<LserdRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      // Entity names often carry the paper's "Full name (ABBR)" convention
      // (e.g. "Triclosan (TCS)") — LSERD's search still returns a hit for
      // that combined string, but far fewer/less relevant matches than
      // searching the bare name, so strip it here just like PubChem does.
      const res = await fetch("/api/lserd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: stripParenthetical(entityName) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Tra cứu thất bại");
      setRows(data.rows as LserdRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tra cứu thất bại");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <Button variant="outline" size="sm" className="h-7 rounded-full text-[11px]" onClick={search} disabled={loading}>
        {loading ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}
        Tra LSERD (E/S/A/B/V)
      </Button>
      {open && (
        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-2">
          {loading && <p className="text-[11px] text-muted-foreground">Đang tra cứu...</p>}
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          {!loading && !error && rows && rows.length === 0 && (
            <p className="text-[11px] text-muted-foreground">Không tìm thấy "{entityName}" trong LSERD.</p>
          )}
          {!loading && rows && rows.length > 0 && (
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="px-1.5 py-1 font-medium">Name</th>
                    <th className="px-1.5 py-1 font-medium">E</th>
                    <th className="px-1.5 py-1 font-medium">S</th>
                    <th className="px-1.5 py-1 font-medium">A</th>
                    <th className="px-1.5 py-1 font-medium">B</th>
                    <th className="px-1.5 py-1 font-medium">V</th>
                    <th className="px-1.5 py-1 font-medium">Nguồn</th>
                    <th className="px-1.5 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-1.5 py-1 font-mono">{r.name}</td>
                      <td className="px-1.5 py-1">{r.E || "—"}</td>
                      <td className="px-1.5 py-1">{r.S || "—"}</td>
                      <td className="px-1.5 py-1">{r.A || "—"}</td>
                      <td className="px-1.5 py-1">{r.B || "—"}</td>
                      <td className="px-1.5 py-1">{r.V || "—"}</td>
                      <td className="px-1.5 py-1 text-muted-foreground">{r.shortCite}</td>
                      <td className="px-1.5 py-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => {
                            onApply(r);
                            setOpen(false);
                          }}
                        >
                          Dùng
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PubchemLookup({
  entityName,
  onApplyBasic,
  onApplyPka,
}: {
  entityName: string;
  onApplyBasic: (basic: PubchemBasic) => void;
  onApplyPka: (candidate: PubchemPkaCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ basic: PubchemBasic | null; pkaCandidates: PubchemPkaCandidate[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const res = await searchPubchem(entityName);
      setResult(res);
      if (!res.basic) setError(`Không tìm thấy "${entityName}" trên PubChem.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tra cứu thất bại");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <Button variant="outline" size="sm" className="h-7 rounded-full text-[11px]" onClick={search} disabled={loading}>
        {loading ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}
        Tra PubChem (MW/LogKow/TPSA/pKa)
      </Button>
      {open && (
        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-2 text-[11px]">
          {loading && <p className="text-muted-foreground">Đang tra cứu...</p>}
          {error && <p className="text-destructive">{error}</p>}
          {!loading && result?.basic && (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                <span className="text-muted-foreground">PubChem: </span>
                <span className="font-mono">{result.basic.name}</span>
              </span>
              <span>MW={result.basic.MW || "—"}</span>
              <span>LogKow={result.basic.LogKow || "—"}</span>
              <span>TPSA={result.basic.TPSA || "—"}</span>
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[10px]"
                onClick={() => onApplyBasic(result.basic!)}
              >
                Dùng MW/LogKow/TPSA
              </Button>
            </div>
          )}
          {!loading && result && result.pkaCandidates.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-muted-foreground">
                pKa (dữ liệu thô từ PubChem, có thể nhiều nguồn khác nhau — kiểm tra lại trước khi dùng):
              </p>
              <ul className="flex flex-col gap-1">
                {result.pkaCandidates.map((c, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span>
                      <span className="font-mono">{c.value}</span>{" "}
                      <span className="text-muted-foreground">({c.source})</span>
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => onApplyPka(c)}
                    >
                      Dùng
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// A manual edit replaces whatever the AI determined, so drop its
// provenance/original-value/conversion-note — same convention as
// ValuesEditor's `update()`, so an edited cell reads the same way everywhere
// in the app.
function withEditedValue(
  values: FieldValue[],
  index: number,
  newValue: string,
): FieldValue[] {
  return values.map((v, i) =>
    i === index
      ? {
          ...v,
          value: newValue,
          source: "edited by user",
          provenance: undefined,
          originalValue: undefined,
          conversionNote: undefined,
        }
      : v,
  );
}

function EditableValueCell({
  value,
  onChange,
}: {
  value: FieldValue;
  onChange: (newValue: string) => void;
}) {
  return (
    <input
      value={value.value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="—"
      aria-label={`Giá trị của ${value.name}`}
      className="w-full min-w-[90px] rounded border border-transparent bg-transparent px-1 py-0.5 font-medium focus:border-input focus:bg-background focus:outline-none"
    />
  );
}

function EntitySection({
  title,
  icon,
  entities,
  onValueChange,
  onLserdApply,
  onPubchemApply,
}: {
  title: string;
  icon: ReactNode;
  entities: (PaperCharacteristicMaterial | PaperCharacteristicEntity)[];
  onValueChange: (entityIndex: number, valueIndex: number, newValue: string) => void;
  /** Only passed for the micropollutants section — enables the LSERD lookup button per entity. */
  onLserdApply?: (entityIndex: number, row: LserdRow) => void;
  /** Passed for oxidants and micropollutants — enables the PubChem lookup button per entity. */
  onPubchemApply?: {
    basic: (entityIndex: number, basic: PubchemBasic) => void;
    pka: (entityIndex: number, candidate: PubchemPkaCandidate) => void;
  };
}) {
  if (entities.length === 0) return null;
  return (
    <div>
      <p className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10.5px] normal-case tracking-normal text-foreground">
          {entities.length}
        </span>
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {entities.map((entity, i) => (
          <div key={i} className="flex flex-col gap-3.5 rounded-xl border border-border p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[15px] font-semibold">{entity.name}</span>
              {"role" in entity && entity.role && (
                <Badge variant="secondary" className="rounded-full text-[10px] font-normal text-muted-foreground">
                  {entity.role}
                </Badge>
              )}
            </div>
            {entity.values.length > 0 ? (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left">
                    <th className="pb-1.5 pr-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/80">Property</th>
                    <th className="pb-1.5 pr-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/80">Value</th>
                    <th className="pb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/80">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {entity.values.map((v, j) => (
                    <tr key={j} className="border-t border-border">
                      <td className="py-2 pr-2 font-mono text-muted-foreground">{v.name}</td>
                      <td className="py-2 pr-2">
                        <EditableValueCell
                          value={v}
                          onChange={(newValue) => onValueChange(i, j, newValue)}
                        />
                        {v.originalValue && (
                          <span className="ml-1 font-normal text-muted-foreground">
                            (gốc: {v.originalValue})
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ProvenanceBadge provenance={v.provenance} />
                          {v.source && <span className="text-[11.5px]">{v.source}</span>}
                        </div>
                        {v.conversionNote && (
                          <span className="mt-0.5 block text-[10.5px] text-muted-foreground/80">
                            {v.conversionNote}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-muted-foreground">
                No characteristics extracted
              </p>
            )}
            {(onLserdApply || onPubchemApply) && (
              <div className="flex flex-col gap-2 border-t border-dashed border-border pt-3">
                {onLserdApply && (
                  <LserdLookup
                    entityName={entity.name}
                    onApply={(row) => onLserdApply(i, row)}
                  />
                )}
                {onPubchemApply && (
                  <PubchemLookup
                    entityName={entity.name}
                    onApplyBasic={(basic) => onPubchemApply.basic(i, basic)}
                    onApplyPka={(candidate) => onPubchemApply.pka(i, candidate)}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PaperCharacteristicsStep() {
  const {
    paper,
    schema,
    goBack,
    goNext,
    paperCharacteristics,
    setPaperCharacteristics,
    paperCharacteristicsStatus,
    paperCharacteristicsProgress: progress,
    paperCharacteristicsError: error,
    paperCharacteristicsWarning: warning,
    runPaperCharacteristicsScan,
  } = useWorkflow();
  const loading = paperCharacteristicsStatus === "running";

  // The actual scan (chunking, per-chunk requests, merging) now lives in
  // WorkflowProvider (lib/workflow-context.tsx) — not here — specifically so
  // it keeps running in the background if you navigate to another step
  // (Figures & Variables, Digitize...) while it's still going, instead of
  // being silently abandoned or double-triggered when you come back.
  function run() {
    if (!paper) return;
    runPaperCharacteristicsScan(paper, schema);
  }

  function exportJson() {
    if (!paperCharacteristics) return;
    download(
      "paper_context.json",
      JSON.stringify(paperCharacteristics, null, 2),
      "application/json",
    );
  }

  function updateEntityValue(
    category: "materials" | "oxidants" | "micropollutants",
    entityIndex: number,
    valueIndex: number,
    newValue: string,
  ) {
    if (!paperCharacteristics) return;
    const list = paperCharacteristics[category].map((entity, i) =>
      i === entityIndex
        ? { ...entity, values: withEditedValue(entity.values, valueIndex, newValue) }
        : entity,
    );
    setPaperCharacteristics({ ...paperCharacteristics, [category]: list });
  }

  // Shared by every external-lookup "apply" handler: swaps in a new
  // `values` array for one entity of one category, via the given pure
  // updater (upsertLserdRow / upsertPubchemBasic / upsertPubchemPka).
  function applyEntityValues(
    category: "oxidants" | "micropollutants",
    entityIndex: number,
    updateValues: (values: FieldValue[]) => FieldValue[],
  ) {
    if (!paperCharacteristics) return;
    const list = paperCharacteristics[category].map((entity, i) =>
      i === entityIndex ? { ...entity, values: updateValues(entity.values) } : entity,
    );
    setPaperCharacteristics({ ...paperCharacteristics, [category]: list });
  }

  return (
    <StepShell
      stepId="paper-characteristics"
      title="Materials"
      description="Trích xuất toàn bộ đặc tính vật liệu và hằng số chung từ paper. Kết quả sẽ được dùng làm nguồn dự phòng khi trích xuất giá trị figure — có thể sửa trực tiếp nếu model trích sai."
      onBack={goBack}
      onNext={goNext}
      nextDisabled={!paperCharacteristics}
      nextLabel="Xác nhận & tiếp tục"
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        {paperCharacteristics ? (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Vật liệu", value: paperCharacteristics.materials.length },
              { label: "Chất oxy hóa", value: paperCharacteristics.oxidants.length },
              { label: "Chất ô nhiễm", value: paperCharacteristics.micropollutants.length },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-border px-4 py-3">
                <p className="font-mono text-2xl font-semibold tabular-nums leading-none">{s.value}</p>
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa trích xuất</p>
        )}
        <div className="flex gap-2">
          {paperCharacteristics && (
            <Button variant="outline" size="sm" onClick={exportJson}>
              <BookOpen className="size-4" />
              Tải JSON
            </Button>
          )}
          <Button
            onClick={run}
            disabled={loading}
            variant={paperCharacteristics ? "outline" : "default"}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ScanSearch className="size-4" />
            )}
            <span>
              {loading && progress
                ? `Đang quét đoạn ${progress.done}/${progress.total}...`
                : paperCharacteristics
                  ? "Quét lại"
                  : "Trích xuất đặc tính paper"}
            </span>
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-4 flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      {warning && (
        <p className="mb-4 flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
          <AlertCircle className="size-4" />
          {warning}
        </p>
      )}

      {paperCharacteristics && (
        <div className="space-y-8">
          <p className="text-xs text-muted-foreground">
            Bấm vào một giá trị để chỉnh sửa trực tiếp nếu model trích sai.
          </p>

          <EntitySection
            title="Vật liệu"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.materials}
            onValueChange={(ei, vi, nv) => updateEntityValue("materials", ei, vi, nv)}
          />

          <EntitySection
            title="Chất oxy hóa"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.oxidants}
            onValueChange={(ei, vi, nv) => updateEntityValue("oxidants", ei, vi, nv)}
            onPubchemApply={{
              basic: (ei, basic) => applyEntityValues("oxidants", ei, (values) => upsertPubchemBasic(values, basic)),
              pka: (ei, c) => applyEntityValues("oxidants", ei, (values) => upsertPubchemPka(values, c)),
            }}
          />

          <EntitySection
            title="Chất ô nhiễm"
            icon={<FlaskConical className="size-4 text-primary" />}
            entities={paperCharacteristics.micropollutants}
            onValueChange={(ei, vi, nv) => updateEntityValue("micropollutants", ei, vi, nv)}
            onLserdApply={(ei, row) =>
              applyEntityValues("micropollutants", ei, (values) => upsertLserdRow(values, row))
            }
            onPubchemApply={{
              basic: (ei, basic) =>
                applyEntityValues("micropollutants", ei, (values) => upsertPubchemBasic(values, basic)),
              pka: (ei, c) => applyEntityValues("micropollutants", ei, (values) => upsertPubchemPka(values, c)),
            }}
          />

          {paperCharacteristics.notes && (
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <span aria-hidden className="mt-0.5">
                ⓘ
              </span>
              {paperCharacteristics.notes}
            </p>
          )}
        </div>
      )}

      {!paperCharacteristics && !loading && !error && (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
          <p className="text-sm text-muted-foreground">
            Bấm "Trích xuất đặc tính paper" để bóc tách toàn bộ vật liệu và hằng
            số.
          </p>
        </div>
      )}
    </StepShell>
  );
}
