// Cell Ontology lookup via EBI's Ontology Lookup Service (OLS4). Best-effort + network — used to ground an
// annotation label in a CL term (id + canonical name), as CAP does. Returns [] on any failure so the panel
// degrades to manual entry. No key needed; OLS sends permissive CORS.
export interface OlsHit { id: string; label: string; description?: string }

export async function olsLookup(term: string): Promise<OlsHit[]> {
  const q = term.trim();
  if (!q) return [];
  try {
    const url = `https://www.ebi.ac.uk/ols4/api/search?q=${encodeURIComponent(q)}&ontology=cl&rows=6`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const j: any = await r.json();
    const docs: any[] = j?.response?.docs || [];
    return docs.filter((d) => d.obo_id).map((d) => ({ id: d.obo_id, label: d.label, description: Array.isArray(d.description) ? d.description[0] : d.description }));
  } catch { return []; }
}
