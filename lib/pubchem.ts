"use client";

import { stripParenthetical } from "@/lib/chem-name";

// PubChem PUG REST/PUG View — free, public, and (verified) sends
// Access-Control-Allow-Origin: * on both endpoints used below, so this can
// be called directly from the browser with no server proxy (unlike the UFZ
// LSERD lookup in app/api/lserd/route.ts, which has no CORS header at all).
const PROPERTY_URL = (query: string) =>
  `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/property/MolecularWeight,XLogP,TPSA,IUPACName/JSON`;
const DISSOCIATION_URL = (cid: number) =>
  `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON/?heading=Dissociation+Constants`;

export type PubchemBasic = {
  cid: number;
  name: string;
  MW: string;
  LogKow: string;
  TPSA: string;
};

// pKa has no clean structured field in PubChem (unlike MW/XLogP/TPSA) — it
// only shows up as free-text experimental annotations pulled from sources
// like HSDB/DrugBank (e.g. "pKa = 13.9" or "15.96, -3.8" for two different
// dissociable groups), so this is returned as raw candidates for the user to
// read and pick from rather than a single parsed number.
export type PubchemPkaCandidate = {
  value: string;
  source: string;
};

export type PubchemSearchResult = {
  basic: PubchemBasic | null;
  pkaCandidates: PubchemPkaCandidate[];
};

// PubChem's name endpoint requires an EXACT registered name/synonym match —
// no fuzzy matching. Entity names coming out of Materials extraction are
// whatever string the paper's own prose used, which very often is the
// "Full name (ABBR)" convention papers use on first mention (e.g. "Triclosan
// (TCS)", "Atrazine (ATZ)") — PubChem 404s on that combined string even
// though the plain name alone resolves fine, which reads to a user as "this
// well-known compound isn't in PubChem" when it's really just a string-match
// artifact. Strips zero-width/invisible characters (another realistic
// PDF-text-extraction artifact that silently breaks an otherwise-correct
// name) and, on a 404, retries with the parenthetical stripped and then with
// just its contents (the abbreviation alone), stopping at the first hit.
function normalizeQuery(name: string): string {
  return name.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function candidateQueries(query: string): string[] {
  const normalized = normalizeQuery(query);
  const candidates = [normalized];
  const outside = stripParenthetical(normalized);
  if (outside !== normalized && !candidates.includes(outside)) candidates.push(outside);
  const insideMatch = normalized.match(/\(([^)]+)\)/);
  const inside = insideMatch?.[1]?.trim();
  if (inside && !candidates.includes(inside)) candidates.push(inside);
  return candidates;
}

async function fetchPubchemOnce(query: string): Promise<PubchemSearchResult> {
  const propRes = await fetch(PROPERTY_URL(query));
  if (propRes.status === 404) return { basic: null, pkaCandidates: [] };
  if (!propRes.ok) throw new Error(`PubChem trả về lỗi (status ${propRes.status})`);
  const propJson = await propRes.json();
  const prop = propJson?.PropertyTable?.Properties?.[0];
  if (!prop) return { basic: null, pkaCandidates: [] };

  const basic: PubchemBasic = {
    cid: prop.CID,
    name: prop.IUPACName || query,
    MW: prop.MolecularWeight != null ? String(prop.MolecularWeight) : "",
    LogKow: prop.XLogP != null ? String(prop.XLogP) : "",
    TPSA: prop.TPSA != null ? String(prop.TPSA) : "",
  };

  let pkaCandidates: PubchemPkaCandidate[] = [];
  try {
    const viewRes = await fetch(DISSOCIATION_URL(prop.CID));
    if (viewRes.ok) pkaCandidates = extractPkaCandidates(await viewRes.json());
  } catch {
    // Best-effort only — the structured properties above already succeeded,
    // so a failure here shouldn't take down the whole lookup.
  }

  return { basic, pkaCandidates };
}

export async function searchPubchem(query: string): Promise<PubchemSearchResult> {
  let last: PubchemSearchResult = { basic: null, pkaCandidates: [] };
  for (const candidate of candidateQueries(query)) {
    last = await fetchPubchemOnce(candidate);
    if (last.basic) return last;
  }
  return last;
}

function extractPkaCandidates(view: unknown): PubchemPkaCandidate[] {
  const record = (view as { Record?: Record<string, unknown> })?.Record;
  if (!record) return [];

  const referenceNames = new Map<number, string>();
  for (const ref of (record.Reference as Array<Record<string, unknown>>) ?? []) {
    if (typeof ref.ReferenceNumber === "number") {
      referenceNames.set(ref.ReferenceNumber, (ref.SourceName as string) || "");
    }
  }

  const out: PubchemPkaCandidate[] = [];
  function walk(sections: Array<Record<string, unknown>> | undefined): void {
    for (const section of sections ?? []) {
      if (section.TOCHeading === "Dissociation Constants") {
        for (const info of (section.Information as Array<Record<string, unknown>>) ?? []) {
          const markup = (info.Value as { StringWithMarkup?: Array<{ String?: string }> })
            ?.StringWithMarkup;
          const refNum = info.ReferenceNumber as number | undefined;
          const source =
            (refNum != null ? referenceNames.get(refNum) : undefined) ||
            (info.Description as string) ||
            "PubChem";
          for (const item of markup ?? []) {
            if (item.String) out.push({ value: item.String, source });
          }
        }
      }
      walk(section.Section as Array<Record<string, unknown>> | undefined);
    }
  }
  walk(record.Section as Array<Record<string, unknown>> | undefined);
  return out;
}
