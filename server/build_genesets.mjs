// Build symbol-keyed gene-set COLLECTIONS + the manifest (index.json) the viewer reads. Each builder runs only if its
// inputs are present in /tmp, so you can rebuild one source without the others; the manifest is rederived by scanning
// the output dir. Everything is symbol-keyed (no IDs). Run: node server/build_genesets.mjs
//
// Inputs (pre-download to /tmp):
//   Reactome (CC0):  /tmp/reactome_human.tsv  = NCBI2Reactome_All_Levels.txt | grep 'Homo sapiens'   (Entrez \t pathwayId \t url \t name \t evidence \t species)
//                    /tmp/entrez2sym.tsv      = NCBI Homo_sapiens.gene_info   (Entrez \t Symbol)
//   GO (CC-BY-4.0):  /tmp/goa_human.gaf.gz    = current.geneontology.org/annotations/goa_human.gaf.gz
//                    /tmp/go-basic.obo        = current.geneontology.org/ontology/go-basic.obo
import fs from "node:fs";
import zlib from "node:zlib";

const OUT = "web/public/genesets";
const MIN = 5, MAX = 500;   // set-size window — tiny sets are noisy, huge ones (>500) are unspecific
const DATE = "2026-06-30";
fs.mkdirSync(OUT, { recursive: true });

function writeColl(id, doc) {
  const json = JSON.stringify(doc);
  fs.writeFileSync(`${OUT}/${id}.json`, json);
  fs.writeFileSync(`${OUT}/${id}.json.gz`, zlib.gzipSync(json));
  console.log(`  ${id}: ${doc.n_pathways} sets · ${doc.n_genes} genes · ${(json.length / 1e6).toFixed(2)}MB raw / ${(zlib.gzipSync(json).length / 1e3).toFixed(0)}KB gz`);
}

// ---------- Reactome (skipped unless its dump is present; the existing asset is left in place) ----------
function buildReactome() {
  if (!fs.existsSync("/tmp/reactome_human.tsv") || !fs.existsSync("/tmp/entrez2sym.tsv")) { console.log("reactome: dump absent → keeping existing asset"); return; }
  console.log("reactome:");
  const e2s = new Map();
  for (const line of fs.readFileSync("/tmp/entrez2sym.tsv", "utf8").split("\n")) {
    const t = line.indexOf("\t"); if (t < 0) continue;
    const id = line.slice(0, t), sym = line.slice(t + 1).trim();
    if (sym && sym !== "-") e2s.set(id, sym);
  }
  const path = new Map();
  for (const line of fs.readFileSync("/tmp/reactome_human.tsv", "utf8").split("\n")) {
    if (!line) continue;
    const c = line.split("\t"); const sym = e2s.get(c[0]); if (!sym) continue;
    let p = path.get(c[1]); if (!p) { p = { name: (c[3] || "").trim(), genes: new Set() }; path.set(c[1], p); }
    p.genes.add(sym);
  }
  const pathways = {}; const allGenes = new Set(); let kept = 0;
  for (const [pid, p] of path) { if (p.genes.size < MIN || p.genes.size > MAX) continue; pathways[pid] = { name: p.name, genes: [...p.genes].sort() }; p.genes.forEach((g) => allGenes.add(g)); kept++; }
  writeColl("reactome_human", { id: "reactome_human", label: "Reactome", source: "Reactome", organism: "human", license: "CC0", built: DATE, min: MIN, max: MAX, n_pathways: kept, n_genes: allGenes.size, pathways });
}

// ---------- GO (GAF annotations + OBO term graph; annotations UP-PROPAGATED over is_a/part_of — the true-path rule) ----------
function buildGO() {
  if (!fs.existsSync("/tmp/goa_human.gaf.gz") || !fs.existsSync("/tmp/go-basic.obo")) { console.log("GO: inputs absent → skipping"); return; }
  console.log("GO:");
  // OBO → id → {name, ns, parents}; drop obsolete terms.
  const term = new Map();
  for (const b of fs.readFileSync("/tmp/go-basic.obo", "utf8").split("\n[Term]")) {
    const id = (b.match(/^id: (GO:\d+)/m) || [])[1]; if (!id) continue;
    if (/^is_obsolete: true/m.test(b)) continue;
    const name = (b.match(/^name: (.+)/m) || [])[1] || id;
    const ns = (b.match(/^namespace: (.+)/m) || [])[1] || "";
    const parents = [...b.matchAll(/^is_a: (GO:\d+)/mg)].map((m) => m[1]).concat([...b.matchAll(/^relationship: part_of (GO:\d+)/mg)].map((m) => m[1]));
    term.set(id, { name, ns, parents });
  }
  // memoized ancestor closure over is_a + part_of (GO is a DAG)
  const ancCache = new Map();
  const anc = (id) => {
    if (ancCache.has(id)) return ancCache.get(id);
    const out = new Set(); ancCache.set(id, out);
    const t = term.get(id); if (t) for (const p of t.parents) if (term.has(p)) { out.add(p); for (const a of anc(p)) out.add(a); }
    return out;
  };
  // GAF → direct annotations (skip NOT-qualified); col3 = symbol, col4 = qualifier, col5 = GO id
  const gaf = zlib.gunzipSync(fs.readFileSync("/tmp/goa_human.gaf.gz")).toString("utf8");
  // GAF col3 is usually the HGNC symbol, but TrEMBL entries put a UniProt accession or a "_HUMAN" mnemonic there —
  // drop those so the gene space is honest symbols (they'd never match a dataset gene anyway).
  const UNIPROT = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})$/;
  const direct = new Map();
  for (const line of gaf.split("\n")) {
    if (!line || line[0] === "!") continue;
    const c = line.split("\t"); const sym = c[2], qual = c[3] || "", go = c[4];
    if (!sym || sym.includes("_") || UNIPROT.test(sym) || !go || !go.startsWith("GO:") || /\bNOT\b/.test(qual)) continue;
    let s = direct.get(go); if (!s) direct.set(go, s = new Set()); s.add(sym);
  }
  // propagate each gene to the annotated term + all its ancestors
  const full = new Map();
  for (const [go, genes] of direct) {
    const targets = new Set([go]); for (const a of anc(go)) targets.add(a);
    for (const t of targets) { let s = full.get(t); if (!s) full.set(t, s = new Set()); for (const g of genes) s.add(g); }
  }
  const aspects = [["biological_process", "bp", "GO:BP"], ["molecular_function", "mf", "GO:MF"], ["cellular_component", "cc", "GO:CC"]];
  for (const [ns, splitLow, label] of aspects) {
    const pathways = {}; const allGenes = new Set(); let kept = 0;
    for (const [go, genes] of full) {
      const t = term.get(go); if (!t || t.ns !== ns) continue;
      if (genes.size < MIN || genes.size > MAX) continue;
      pathways[go] = { name: t.name, genes: [...genes].sort() }; genes.forEach((g) => allGenes.add(g)); kept++;
    }
    writeColl(`go_${splitLow}_human`, { id: `go_${splitLow}_human`, label, source: "GO", split: splitLow.toUpperCase(), organism: "human", license: "GO/CC-BY-4.0", built: DATE, min: MIN, max: MAX, n_pathways: kept, n_genes: allGenes.size, pathways });
  }
}

// ---------- manifest: scan the output dir so it always reflects what's on disk ----------
function writeManifest() {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".json") && f !== "index.json");
  const collections = files.map((f) => {
    const o = JSON.parse(fs.readFileSync(`${OUT}/${f}`, "utf8"));
    const id = o.id || f.replace(/\.json$/, "");
    return { id, label: o.label || o.source || id, source: o.source || "Reactome", organism: o.organism || "human", split: o.split, license: o.license, file: f, nPathways: o.n_pathways, nGenes: o.n_genes };
  });
  // GO splits first (GO:BP is the viewer's default), then Reactome, then anything else — stable, source-grouped order.
  const rank = (c) => (c.source === "GO" ? 0 : c.source === "Reactome" ? 1 : 2);
  collections.sort((a, b) => rank(a) - rank(b) || (a.split || "").localeCompare(b.split || "") || a.label.localeCompare(b.label));
  fs.writeFileSync(`${OUT}/index.json`, JSON.stringify({ v: 1, built: DATE, collections }, null, 2));
  console.log(`manifest: ${collections.length} collections → ${OUT}/index.json`);
}

buildReactome();
buildGO();
writeManifest();
