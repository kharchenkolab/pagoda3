// The PANEL TYPE registry — modules plug into it instead of a hardcoded `bodyFor` switch + a static agent type list.
// This is the panel analogue of the render/style.ts descriptor registry: a panel TYPE declares its renderer (+ whether
// the agent may add it) and REGISTERS itself; the core looks it up. So adding a panel type = ship a module that calls
// registerPanelType — ZERO edits to bodyFor / the agent's validated type list. Pure + dependency-free (the body type is
// kept loose to avoid a cycle with panels.ts) → node --test can exercise the registry with a mock.

// A panel's renderer: (panel, ctx, hooks) → its DOM body (BuiltBody, possibly async). Typed loosely here; the real
// types bind at the registration site (panels.ts) where the actual body functions are passed.
export type PanelBody = (p: any, ctx: any, hooks: any) => any;

// A panel's DATA NEED — a declarative request the provisioner (ctx.provision) materializes EAGERLY + concurrently
// (warm a present field / compute an absent capability once, deduped) at render time, instead of the panel pulling
// it lazily on its own fill. This is the panel-derived successor to the boot recipe: each panel declares what IT
// reads, as a FUNCTION of its spec + the catalog, so the prefetch tracks the actual mounted layout and can't go
// stale as data/panels/workspaces broaden. Present field ⇒ a prefetch; absent capability ⇒ the underlying method
// computes it once (markers/groupStats fall back to the counts matrix). See ctx.provision.
export type Need =
  | { kind: "obs"; field: string }         // a per-cell metadata column (categorical or numeric)
  | { kind: "allObs" }                     // every per-cell metadata column (the Metadata facet browser needs them all)
  | { kind: "grouping"; name: string }     // a categorical grouping (its codes/categories)
  | { kind: "groupStats"; group: string }  // per-group sufficient stats for a grouping (dotplot/heatmap)
  | { kind: "markers"; group: string };    // marker genes for a grouping

// Derive a panel's needs from its spec + the ctx (catalog). Pure + synchronous — it declares intent; the
// provisioner does the async warming. Omitted ⇒ the panel has no eager needs (fills purely lazily).
export type PanelNeeds = (p: any, ctx: any) => Need[];

export interface PanelTypeDef {
  type: string;          // the panel-type string (e.g. "Embedding", "Heatmap", "Widget")
  body: PanelBody;       // the renderer
  agent?: boolean;       // true ⇒ in the agent's VALIDATED type list (the model may add:<type> / reference it)
  title?: string;        // optional default title / menu label
  needs?: PanelNeeds;    // optional: the data this panel type reads, provisioned eagerly at render (see Need)
}

const REGISTRY = new Map<string, PanelTypeDef>();

export function registerPanelType(def: PanelTypeDef): void { REGISTRY.set(def.type, def); }
export function getPanelType(type: string): PanelTypeDef | undefined { return REGISTRY.get(type); }
export function isPanelType(type: string): boolean { return REGISTRY.has(type); }
export function panelTypes(): string[] { return [...REGISTRY.keys()]; }                       // every renderable type
export function agentPanelTypes(): string[] { return [...REGISTRY.values()].filter((d) => d.agent).map((d) => d.type); }   // the agent-validated subset (the old REGISTRY)
export function isAgentPanelType(type: string): boolean { return !!REGISTRY.get(type)?.agent; }
