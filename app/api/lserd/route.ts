// Server-side proxy for the UFZ LSER-Database (Abraham solvation parameters
// E, S, A, B, V for neutral chemicals — https://web.app.ufz.de/compbc/lserd).
// Must be called from the SERVER: the endpoint sends no
// Access-Control-Allow-Origin header, so a browser-side fetch from our own
// origin is blocked by CORS even though the request itself needs no
// cookie/session/auth (verified with credentials:"omit" directly against the
// endpoint). A plain server-to-server request isn't subject to CORS at all.
//
// Terms of use (https://web.app.ufz.de/compbc/lserd/public/Public/policy/):
// free for scientific/private use with attribution, no commercial use, and
// no stated restriction on automated access — hence the citation string
// returned alongside every row below.
export const runtime = "edge";

const LSERD_ENDPOINT = "https://web.app.ufz.de/compbc/lserd/ajax/Public/ajaxTable";
const LSERD_CITATION =
  "UFZ-LSER database 4.1.2 [Internet], Leipzig, Germany, Helmholtz Centre for Environmental Research-UFZ. Available from https://www.ufz.de/lserd";

export type LserdRow = {
  name: string;
  cas: string;
  smiles: string;
  E: string;
  S: string;
  A: string;
  B: string;
  V: string;
  L: string;
  shortCite: string;
  citation: string;
  year: string;
};

// Column layout of each row in the raw `data` array, reverse-engineered from
// the live response (no documented schema) — see chat history for the probe.
// Index 1 and 11 are unidentified always-present columns, kept unused here.
const COL = {
  name: 2,
  cas: 3,
  smiles: 4,
  E: 5,
  S: 6,
  A: 7,
  B: 8,
  V: 9,
  L: 10,
  citation: 12,
  shortCite: 13,
  year: 14,
} as const;

export async function POST(req: Request) {
  try {
    const { query } = (await req.json()) as { query: string };
    if (!query || !query.trim()) {
      return Response.json({ error: "Thiếu tên chất cần tra cứu" }, { status: 400 });
    }

    const body = new URLSearchParams({
      "lserd_data[searchString]": query.trim(),
      "lserd_data[checkSmiles]": "1",
      "lserd_data[checkCas]": "1",
      "lserd_data[checkName]": "1",
      "lserd_data[radioExperimental]": "1",
      "lserd_data[filterDuplicate]": "0",
      "lserd_data[chiralMarkings]": "0",
    }).toString();

    const res = await fetch(LSERD_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });

    if (!res.ok) {
      return Response.json(
        { error: `LSERD trả về lỗi (status ${res.status})` },
        { status: 502 },
      );
    }

    const json = (await res.json()) as { count: number; data: string[][]; warning?: string };
    const rows: LserdRow[] = (json.data ?? []).map((r) => ({
      name: r[COL.name] ?? "",
      cas: r[COL.cas] ?? "",
      smiles: r[COL.smiles] ?? "",
      E: r[COL.E] ?? "",
      S: r[COL.S] ?? "",
      A: r[COL.A] ?? "",
      B: r[COL.B] ?? "",
      V: r[COL.V] ?? "",
      L: r[COL.L] ?? "",
      shortCite: r[COL.shortCite] ?? "",
      citation: r[COL.citation] ?? "",
      year: r[COL.year] ?? "",
    }));

    return Response.json({ rows, warning: json.warning || "", citation: LSERD_CITATION });
  } catch (err) {
    console.error("lserd search failed:", err);
    return Response.json({ error: "Không tra cứu được LSERD, thử lại giúp mình" }, { status: 500 });
  }
}
