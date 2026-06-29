// Pure cell-set algebra — the compositional "what to compute over" layer. A CellSet is a small expression
// over named leaf sets (a category's cells, the current selection / focus, all cells) closed under boolean
// ops (complement / intersect / union). The compute primitive resolves its operands through this, so the
// agent can run a statistic over ANY set it can describe — selection-vs-cluster, an intersection vs a union,
// day0∩CD8 vs day7∩CD8 — instead of only pre-baked combinations. The narrow waist replaces a fan of verbs
// (run_de_on_selection, de_between, get_overdispersed_genes) with: cell-set → statistic → view.
//
// Pure + dependency-free: leaf resolution is injected, so node --test runs it directly.

export type CellSet =
  | { category: { grouping: string; value: string } }
  | { selection: true }
  | { focus: true }
  | { all: true }
  | { set: number[] }   // a LITERAL set of cell indices — self-contained (needs no env). The UI uses it to pin a manual lasso as a fixed group (e.g. comparison group B); the agent never emits it.
  | { complement: CellSet }
  | { intersect: CellSet[] }
  | { union: CellSet[] };

// What validation needs to know about the world (supplied by the caller so this stays pure).
export interface CellWorld {
  categoricals: string[];
  valuesOf: (field: string) => string[];
  hasSelection: boolean;
  hasFocus: boolean;
}

// Leaf resolvers + cell count, injected by the caller (App) for execution.
export interface CellEnv {
  n: number;
  category: (grouping: string, value: string) => Iterable<number>;
  selection: () => Iterable<number>;
  focus: () => Iterable<number>;
}

const KEYS = ["category", "selection", "focus", "all", "set", "complement", "intersect", "union"];

function soleKey(expr: any): string | null {
  if (!expr || typeof expr !== "object") return null;
  const ks = KEYS.filter((k) => k in expr);
  return ks.length === 1 ? ks[0] : null;
}

// Returns an error string if the expression is malformed or references something unknown, else null.
export function validateCellSet(expr: any, w: CellWorld, where = "cellset"): string | null {
  const k = soleKey(expr);
  if (!k) return `${where}: must be exactly one of {category, selection, focus, all, complement, intersect, union}`;
  if (k === "all") return null;
  if (k === "set") { const a = (expr as any).set; return Array.isArray(a) && a.length > 0 && a.every((x: any) => Number.isInteger(x)) ? null : `${where}: set needs a non-empty array of cell indices`; }
  if (k === "selection") return w.hasSelection ? null : `${where}: no active selection — ask the user to select cells first`;
  if (k === "focus") return w.hasFocus ? null : `${where}: no active focus`;
  if (k === "category") {
    const c = expr.category;
    if (!c || typeof c.grouping !== "string" || typeof c.value !== "string") return `${where}: category needs {grouping, value}`;
    if (!w.categoricals.includes(c.grouping)) return `${where}: unknown field "${c.grouping}" (have: ${w.categoricals.join(", ") || "—"})`;
    if (!w.valuesOf(c.grouping).includes(c.value)) return `${where}: "${c.value}" is not a value of ${c.grouping}`;
    return null;
  }
  if (k === "complement") return validateCellSet(expr.complement, w, `${where}.complement`);
  const arr = expr[k];   // intersect | union
  if (!Array.isArray(arr) || arr.length < 1) return `${where}: ${k} needs a non-empty array of cell sets`;
  for (let i = 0; i < arr.length; i++) { const e = validateCellSet(arr[i], w, `${where}.${k}[${i}]`); if (e) return e; }
  return null;
}

function toSet(it: Iterable<number>): Set<number> { return it instanceof Set ? it as Set<number> : new Set(it); }

// Resolve to a Set of cell indices. Leaf sets come from env; boolean ops are pure. Assumes a valid expr.
export function resolveCellSet(expr: CellSet, env: CellEnv): Set<number> {
  const k = soleKey(expr)!;
  if (k === "all") { const s = new Set<number>(); for (let i = 0; i < env.n; i++) s.add(i); return s; }
  if (k === "set") return new Set((expr as any).set as number[]);
  if (k === "category") { const c = (expr as any).category; return toSet(env.category(c.grouping, c.value)); }
  if (k === "selection") return toSet(env.selection());
  if (k === "focus") return toSet(env.focus());
  if (k === "complement") { const inner = resolveCellSet((expr as any).complement, env); const s = new Set<number>(); for (let i = 0; i < env.n; i++) if (!inner.has(i)) s.add(i); return s; }
  if (k === "intersect") {
    const parts: Set<number>[] = (expr as any).intersect.map((e: CellSet) => resolveCellSet(e, env));
    parts.sort((a, b) => a.size - b.size);   // iterate the smallest
    const [first, ...rest] = parts; const out = new Set<number>();
    if (first) for (const x of first) if (rest.every((s) => s.has(x))) out.add(x);
    return out;
  }
  const out = new Set<number>();   // union
  for (const e of (expr as any).union) for (const x of resolveCellSet(e, env)) out.add(x);
  return out;
}

// A short human label for a cell set — used for titles and DE column headers.
export function describeCellSet(expr: CellSet): string {
  const k = soleKey(expr)!;
  if (k === "all") return "all cells";
  if (k === "set") return `${(expr as any).set.length} cells`;
  if (k === "selection") return "selection";
  if (k === "focus") return "focus";
  if (k === "category") return (expr as any).category.value;
  if (k === "complement") return `not ${describeCellSet((expr as any).complement)}`;
  if (k === "intersect") return (expr as any).intersect.map(describeCellSet).join(" ∩ ");
  return (expr as any).union.map(describeCellSet).join(" ∪ ");
}
