import type { FieldValue, PaperCharacteristicsResult } from "@/lib/types";

// Shared by both the server (app/api/extract/route.ts's deterministic
// fallback-fill for figure_extract) and the client (Fill Values' per-series
// entity table, Dataset's CSV export join) — one fuzzy name-matching
// definition instead of two copies drifting apart.
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function keysLikelyMatch(a: string, b: string): boolean {
  const na = normKey(a);
  const nb = normKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

export type EntityCategory = "materials" | "oxidants" | "micropollutants";
export type EntityOption = { name: string; category: EntityCategory };

function allEntities(pc: PaperCharacteristicsResult | null | undefined) {
  if (!pc) return [];
  return [...pc.materials, ...pc.oxidants, ...pc.micropollutants];
}

export function listEntityOptions(pc: PaperCharacteristicsResult | null | undefined): EntityOption[] {
  if (!pc) return [];
  return [
    ...pc.materials.map((m) => ({ name: m.name, category: "materials" as const })),
    ...pc.oxidants.map((o) => ({ name: o.name, category: "oxidants" as const })),
    ...pc.micropollutants.map((m) => ({ name: m.name, category: "micropollutants" as const })),
  ];
}

/**
 * Whether a figure's series/curve dimension is itself the entity identity
 * (e.g. one curve per catalyst — "Cu/CuFe2O4", "CuFe2O4") as opposed to some
 * other condition (pH, water matrix, dosage...) swept across curves that all
 * share the SAME single catalyst/oxidant/micropollutant. Only in the former
 * case does it make sense to ask the user to map EACH series to an entity —
 * mapping "pH 3.5" / "Tap water" to "which catalyst?" one row at a time is
 * nonsensical busywork when every curve in the figure is the same substance.
 * Matches by name against known entities from Materials; a figure with no
 * series named after any known entity is assumed to be the latter case.
 */
export function seriesListMatchesAnyEntity(
  seriesList: string[],
  pc: PaperCharacteristicsResult | null | undefined,
): boolean {
  const options = listEntityOptions(pc);
  if (options.length === 0) return false;
  return seriesList.some((s) => options.some((opt) => keysLikelyMatch(opt.name, s)));
}

const ENTITY_CATEGORIES: EntityCategory[] = ["materials", "oxidants", "micropollutants"];

/**
 * A schema field is "entity-dependent" only when it's PROVEN to vary: at
 * least two entities of the SAME category (e.g. two different catalysts)
 * both report a non-empty value for it, and those values actually differ.
 *
 * Merely finding the field name attached to ONE entity's `values` is NOT
 * enough evidence — Materials extraction sometimes attributes a shared
 * experimental condition (e.g. "PS dosage", "TC concentration") to whichever
 * single oxidant/micropollutant happens to be named nearby in the source
 * text, even though the SAME dosage applies across the whole paper (Fill
 * Values finds the real number directly from the figure's own caption/text
 * anyway — see figure_extract's rule 4). Treating that as "entity-dependent"
 * hid the field from Fill Values' normal fixed-value editor entirely and
 * routed it through the per-series entity table, where it resolved to
 * nothing (that one entity's own copy of the field was empty) or the wrong
 * figure-wide number — exactly the bug this guards against. A field that's
 * genuinely tied to which entity a curve represents (SBET, pHpzc, MW,
 * LogKow...) will have DIFFERENT values on two different entities of the
 * same kind; a shared condition won't.
 */
export function isEntityDependentField(
  pc: PaperCharacteristicsResult | null | undefined,
  fieldName: string,
  fieldDescription?: string,
): boolean {
  if (!pc) return false;
  for (const category of ENTITY_CATEGORIES) {
    const values = pc[category]
      .map(
        (e) =>
          e.values.find(
            (v) =>
              v.value?.trim() &&
              (keysLikelyMatch(v.name, fieldName) || (!!fieldDescription && keysLikelyMatch(v.name, fieldDescription))),
          )?.value?.trim(),
      )
      .filter((v): v is string => !!v);
    if (values.length >= 2 && new Set(values).size >= 2) return true;
  }
  return false;
}

/** Looks up `fieldName`'s value on the entity named `entityName` (exact name match, fuzzy property match). */
export function lookupEntityFieldValue(
  pc: PaperCharacteristicsResult | null | undefined,
  entityName: string,
  fieldName: string,
  fieldDescription?: string,
): FieldValue | undefined {
  const entity = allEntities(pc).find((e) => e.name === entityName);
  if (!entity) return undefined;
  return entity.values.find(
    (v) =>
      v.value?.trim() &&
      (keysLikelyMatch(v.name, fieldName) || (!!fieldDescription && keysLikelyMatch(v.name, fieldDescription))),
  );
}
