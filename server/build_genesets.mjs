// Build a compact, symbol-keyed Reactome pathway gene-set asset for the viewer (over-representation / signature input).
// Reactome content is CC0, so this is cleanly redistributable. Inputs are pre-downloaded to /tmp (see the curl in the
// session); this just joins + filters + writes. Run: node server/build_genesets.mjs
//   /tmp/reactome_human.tsv  = NCBI2Reactome_All_Levels.txt filtered to `Homo sapiens`  (Entrez \t pathwayId \t url \t name \t evidence \t species)
//   /tmp/entrez2sym.tsv      = NCBI Homo_sapiens.gene_info  (Entrez \t Symbol)
import fs from "node:fs";
import zlib from "node:zlib";

const MIN = 5, MAX = 500;   // pathway size window — tiny sets are noisy, huge ones (>500) are unspecific "Immune System"-level

const e2s = new Map();
for (const line of fs.readFileSync("/tmp/entrez2sym.tsv", "utf8").split("\n")) {
  const t = line.indexOf("\t"); if (t < 0) continue;
  const id = line.slice(0, t), sym = line.slice(t + 1).trim();
  if (sym && sym !== "-") e2s.set(id, sym);
}

const path = new Map();   // pathwayId -> { name, genes:Set<symbol> }
for (const line of fs.readFileSync("/tmp/reactome_human.tsv", "utf8").split("\n")) {
  if (!line) continue;
  const c = line.split("\t"); const entrez = c[0], pid = c[1], name = (c[3] || "").trim();
  const sym = e2s.get(entrez); if (!sym) continue;
  let p = path.get(pid); if (!p) { p = { name, genes: new Set() }; path.set(pid, p); }
  p.genes.add(sym);
}

const pathways = {}; const allGenes = new Set(); let kept = 0, dropped = 0;
for (const [pid, p] of path) {
  if (p.genes.size < MIN || p.genes.size > MAX) { dropped++; continue; }
  pathways[pid] = { name: p.name, genes: [...p.genes].sort() };
  p.genes.forEach((g) => allGenes.add(g)); kept++;
}

const doc = { source: "Reactome", license: "CC0", organism: "human", built: "2026-06-29", min: MIN, max: MAX, n_pathways: kept, n_genes: allGenes.size, pathways };
const json = JSON.stringify(doc);
fs.mkdirSync("web/public/genesets", { recursive: true });
fs.writeFileSync("web/public/genesets/reactome_human.json", json);
const gz = zlib.gzipSync(json);
fs.writeFileSync("web/public/genesets/reactome_human.json.gz", gz);

console.log(`pathways kept: ${kept}  (dropped ${dropped} outside ${MIN}–${MAX} genes)`);
console.log(`unique genes covered: ${allGenes.size}`);
console.log(`JSON: ${(json.length / 1e6).toFixed(2)} MB raw · ${(gz.length / 1e3).toFixed(0)} KB gzipped`);
console.log(`median pathway size: ${(() => { const s = Object.values(pathways).map((p) => p.genes.length).sort((a, b) => a - b); return s[s.length >> 1]; })()}`);
