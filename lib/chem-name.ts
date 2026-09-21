// Shared by both external chemical-database lookups (PubChem in
// lib/pubchem.ts, UFZ LSERD in paper-characteristics-step.tsx): entity names
// coming out of Materials extraction are whatever string the paper's own
// prose used, which very often is the "Full name (ABBR)" convention papers
// use on first mention (e.g. "Triclosan (TCS)", "Atrazine (ATZ)"). Neither
// database matches that combined string as well as the plain name alone —
// PubChem's exact-name endpoint 404s on it outright, and LSERD's search
// returns far fewer/less relevant hits than searching the bare name.
export function stripParenthetical(name: string): string {
  const stripped = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return stripped || name;
}
