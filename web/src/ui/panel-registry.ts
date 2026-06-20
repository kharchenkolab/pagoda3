// The PANEL TYPE registry — modules plug into it instead of a hardcoded `bodyFor` switch + a static agent type list.
// This is the panel analogue of the render/style.ts descriptor registry: a panel TYPE declares its renderer (+ whether
// the agent may add it) and REGISTERS itself; the core looks it up. So adding a panel type = ship a module that calls
// registerPanelType — ZERO edits to bodyFor / the agent's validated type list. Pure + dependency-free (the body type is
// kept loose to avoid a cycle with panels.ts) → node --test can exercise the registry with a mock.

// A panel's renderer: (panel, ctx, hooks) → its DOM body (BuiltBody, possibly async). Typed loosely here; the real
// types bind at the registration site (panels.ts) where the actual body functions are passed.
export type PanelBody = (p: any, ctx: any, hooks: any) => any;

export interface PanelTypeDef {
  type: string;          // the panel-type string (e.g. "Embedding", "Heatmap", "Widget")
  body: PanelBody;       // the renderer
  agent?: boolean;       // true ⇒ in the agent's VALIDATED type list (the model may add:<type> / reference it)
  title?: string;        // optional default title / menu label
}

const REGISTRY = new Map<string, PanelTypeDef>();

export function registerPanelType(def: PanelTypeDef): void { REGISTRY.set(def.type, def); }
export function getPanelType(type: string): PanelTypeDef | undefined { return REGISTRY.get(type); }
export function isPanelType(type: string): boolean { return REGISTRY.has(type); }
export function panelTypes(): string[] { return [...REGISTRY.keys()]; }                       // every renderable type
export function agentPanelTypes(): string[] { return [...REGISTRY.values()].filter((d) => d.agent).map((d) => d.type); }   // the agent-validated subset (the old REGISTRY)
export function isAgentPanelType(type: string): boolean { return !!REGISTRY.get(type)?.agent; }
