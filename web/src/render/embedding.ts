// deck.gl embedding renderer — the one panel that must scale to 10^4..10^6 points.
// Binary attributes (no per-point accessors) so coloring a million cells is a buffer swap.
import { Deck, OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer, TextLayer, LineLayer } from "@deck.gl/layers";
import { CollisionFilterExtension } from "@deck.gl/extensions";
import { themeIsDark, accentRGB } from "./theme.ts";

export class EmbeddingView {
  private deck: Deck;
  private positions: Float32Array;     // 2n (native cell order — picking/selection/brush use this)
  private colors: Uint8Array;          // 4n (native cell order)
  private draw!: Uint32Array;          // shuffled draw order for the cells layer (slot k → cell draw[k])
  private drawPos!: Float32Array;      // 2n positions in draw order
  private drawColors!: Uint8Array;     // 4n colours in draw order
  private selected: Uint8Array;        // n (0/1)
  private n: number;
  private radius = 2.4;
  private pointAlpha = 0.7;   // cells-layer opacity (display.alpha); <1 conveys density
  private container: HTMLElement;
  private viewState: any;
  onSelect?: (ids: Int32Array) => void;
  onHover?: (index: number | null) => void;   // a cell under the cursor (or null) — emits the cross-panel hint
  onPick?: (index: number | null, x?: number, y?: number) => void;   // a plain click: a cell (→ select its cluster) or empty (→ deselect); x/y px for the selpop anchor

  constructor(container: HTMLElement, emb: Float32Array, n: number) {
    this.n = n;
    this.positions = emb;
    this.colors = new Uint8Array(n * 4).fill(180);
    for (let i = 0; i < n; i++) this.colors[i * 4 + 3] = 230;
    this.selected = new Uint8Array(n);

    // Randomized DRAW ORDER for the cells layer. Cells are stored in per-sample blocks, so without this the
    // last sample overdraws the rest and "colour by sample" reads as one donor even when well integrated.
    // Draw-order only — picking, selection and the brush stay in native cell-index space (separate layers).
    this.draw = new Uint32Array(n); for (let i = 0; i < n; i++) this.draw[i] = i;
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)), t = this.draw[i]; this.draw[i] = this.draw[j]; this.draw[j] = t; }
    this.drawPos = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) { const c = this.draw[k]; this.drawPos[k * 2] = emb[c * 2]; this.drawPos[k * 2 + 1] = emb[c * 2 + 1]; }
    this.drawColors = new Uint8Array(n * 4).fill(180); for (let k = 0; k < n; k++) this.drawColors[k * 4 + 3] = 230;

    this.container = container;
    this.viewState = this.computeView();   // fit all cells initially; fitTo(ids) reframes to a subset (scope)

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%"; canvas.style.height = "100%"; canvas.style.display = "block";
    container.appendChild(canvas);

    this.deck = new Deck({
      canvas,
      views: [new OrthographicView({ flipY: false })],
      viewState: this.viewState,
      onViewStateChange: ({ viewState }: any) => { this.viewState = viewState; this.deck.setProps({ viewState }); },   // controlled: keeps pan/zoom while letting fitTo() reframe
      controller: { dragPan: true, scrollZoom: true, doubleClickZoom: false },
      layers: this.layers(),
      // hover IS available in pan mode — picking fires on move, not drag. Emit the picked cell (or null).
      onHover: (info: any) => this.onHover?.(info && info.index != null && info.index >= 0 ? this.draw[info.index] : null),    // draw slot → cell
      // plain click selects the clicked cell's cluster; click on empty space deselects. Shift-clicks are the brush.
      onClick: (info: any) => { if (info?.srcEvent?.shiftKey) return; this.onPick?.(info && info.index != null && info.index >= 0 ? this.draw[info.index] : null, info?.x, info?.y); },
      getCursor: ({ isDragging, isHovering }: any) => (isDragging ? "grabbing" : isHovering ? "crosshair" : "grab"),
    });
    canvas.addEventListener("pointerleave", () => this.onHover?.(null));

    this.installBrush(canvas);

    // The on-plot label CollisionFilterExtension declutters in SCREEN space, so on mount (canvas not yet sized)
    // it culls every label and they stay hidden until the next redraw. Re-render when the container resizes — the
    // post-mount size settle and any later resize — so labels re-evaluate against the real viewport. rAF-coalesced;
    // self-disconnects once the panel is gone.
    let rafR = 0;
    const ro = new ResizeObserver(() => { if (!container.isConnected) { ro.disconnect(); return; } if (rafR) return; rafR = requestAnimationFrame(() => { rafR = 0; if (container.isConnected) this.redraw(); }); });
    ro.observe(container);
  }

  private layers() {
    return [
      new ScatterplotLayer({
        id: "cells",
        data: {
          length: this.n,
          attributes: {
            getPosition: { value: this.drawPos, size: 2 },
            getFillColor: { value: this.drawColors, size: 4 },
          },
        },
        radiusUnits: "pixels",
        getRadius: this.radius,
        radiusMinPixels: 1,
        stroked: false,
        pickable: true,
        opacity: this.pointAlpha,                 // <1 lets overlapping cells convey density
        updateTriggers: { all: this.colorVersion },
      }) as any,
      // selection halo — only for a SMALL freeform selection (pinpoints the cells). A large cluster selection
      // relies on the grey-out instead, so we don't speckle hundreds of cells with cyan rings.
      this.selCount() > 0 && this.selCount() <= 250
        ? new ScatterplotLayer({
            id: "sel",
            data: { length: this.n },
            getPosition: (_: any, { index }: any) => (this.selected[index] ? [this.positions[index * 2], this.positions[index * 2 + 1]] : [1e9, 1e9]),
            radiusUnits: "pixels", getRadius: this.radius + 2.2,
            stroked: true, filled: false, getLineColor: [...accentRGB(), 255], lineWidthUnits: "pixels", getLineWidth: 1.6,
            updateTriggers: { getPosition: this.selVersion },
          }) as any
        : null,
      // CATEGORY hint → a light overlay lifting that category's cells (honest even when they're not compact)
      this.highlightIds && this.highlightIds.length
        ? new ScatterplotLayer({
            id: "hl", data: { length: this.highlightIds.length },
            getPosition: (_: any, { index }: any) => { const c = this.highlightIds![index]; return [this.positions[c * 2], this.positions[c * 2 + 1]]; },
            radiusUnits: "pixels", getRadius: this.radius + 1.6, stroked: false, getFillColor: [...accentRGB(), 200],
            updateTriggers: { getPosition: this.hintVersion },
          }) as any
        : null,
      // CELL hint → full-panel crosshairs intersecting at the cell (precise "you are here", any zoom)
      this.crosshairXY
        ? new LineLayer({
            id: "crosshair",
            data: [{ s: [this.crosshairXY[0], -1e5], t: [this.crosshairXY[0], 1e5] }, { s: [-1e5, this.crosshairXY[1]], t: [1e5, this.crosshairXY[1]] }],
            getSourcePosition: (d: any) => d.s, getTargetPosition: (d: any) => d.t,
            getColor: [...accentRGB(), 150], widthUnits: "pixels", getWidth: 1,
            updateTriggers: { getSourcePosition: this.hintVersion, getTargetPosition: this.hintVersion },
          }) as any
        : null,
      // on-plot category labels at centroids — names ON the map, so orientation isn't swatch-matching.
      // Drawn last (on top); halo'd so they read over any cluster colour. Cleared for numeric colourings.
      // CollisionFilterExtension declutters in screen space each frame: when labels overlap, the
      // higher-priority one (larger cluster) wins; zooming in spreads them so more reveal. No pile-ups.
      this.labels.length
        ? new TextLayer({
            id: "labels", data: this.labels,
            getPosition: (d: any) => d.p, getText: (d: any) => d.text,
            getSize: 12.5, sizeUnits: "pixels", sizeMinPixels: 10, sizeMaxPixels: 15,
            getColor: themeIsDark() ? [240, 244, 250, 255] : [38, 50, 58, 255], getTextAnchor: "middle", getAlignmentBaseline: "center",   // theme-aware on-plot labels: light text+dark halo (dark) / dark text+light halo (white)
            fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif", fontWeight: 700,
            fontSettings: { sdf: true, radius: 14, buffer: 6 }, outlineWidth: 2.4, outlineColor: themeIsDark() ? [9, 13, 20, 255] : [255, 255, 255, 235],
            // a translucent backing plate behind each label so it reads over any cluster colour (esp. light theme,
            // where dark text over a saturated blob was hard) — a soft panel-coloured rectangle, not fully opaque.
            background: true, getBackgroundColor: themeIsDark() ? [13, 17, 23, 150] : [255, 255, 255, 165], backgroundPadding: [5, 2],
            billboard: true, pickable: false, characterSet: "auto",
            extensions: [new CollisionFilterExtension()],
            collisionEnabled: true, collisionGroup: "labels",
            // inflate the hit-box so kept labels keep clear air. sizeMaxPixels must be raised here too,
            // else the base layer's 15px clamp cancels the scale-up and nothing gets decluttered.
            collisionTestProps: { sizeScale: 3, sizeMaxPixels: 64 },
            getCollisionPriority: (d: any) => d.priority,     // larger clusters outrank smaller when they clash
            updateTriggers: { getText: this.labelVersion, getPosition: this.labelVersion, getCollisionPriority: this.labelVersion },
          }) as any
        : null,
    ].filter(Boolean);
  }

  private colorVersion = 0;
  private selVersion = 0;
  private crosshairXY: [number, number] | null = null;   // CELL hint locator (this panel's own embedding coords)
  private highlightIds: Int32Array | null = null;        // CATEGORY hint: cells to lift
  private hintVersion = 0;
  private labels: { text: string; p: [number, number]; priority: number }[] = [];
  private labelVersion = 0;
  private selCount() { let c = 0; for (let i = 0; i < this.n; i++) c += this.selected[i]; return c; }
  private redraw() { this.deck.setProps({ layers: this.layers() }); }

  /** Show (or clear) a subtle locator ring at a data-space point — the cross-panel hover cue. */
  /** CELL hint: crosshairs at cell `i` in THIS panel's embedding (null clears). Each panel resolves the same
   *  cell to its own coords — so hovering a cell marks it in the before AND after embeddings at once. */
  setCrosshairCell(i: number | null) { this.crosshairXY = i == null ? null : [this.positions[i * 2], this.positions[i * 2 + 1]]; this.hintVersion++; this.redraw(); }
  /** CATEGORY hint: lift a set of cells as a light overlay (null clears). */
  setHighlightCells(ids: Int32Array | null) { this.highlightIds = ids; this.hintVersion++; this.redraw(); }

  /** Point opacity for the cells layer — <1 reveals density through overlap. */
  setAlpha(a: number) { if (a === this.pointAlpha || !(a > 0)) return; this.pointAlpha = a; this.redraw(); }

  /** Place category names at their centroids (categorical colouring); pass [] to clear (numeric colouring). */
  setLabels(labels: { text: string; p: [number, number]; priority: number }[]) { this.labels = labels; this.labelVersion++; this.redraw(); }

  /** A view state (target + zoom) that frames a cell SET — or all cells when ids is empty/undefined. */
  private computeView(ids?: Int32Array): any {
    const emb = this.positions, count = ids && ids.length ? ids.length : this.n;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < count; k++) { const i = ids && ids.length ? ids[k] : k; const x = emb[i * 2], y = emb[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1, rect = this.container.getBoundingClientRect();
    const ppu = Math.min((rect.width || 800) / spanX, (rect.height || 600) / spanY) * 0.86;
    return { target: [(minX + maxX) / 2, (minY + maxY) / 2, 0], zoom: Math.log2(Math.max(ppu, 1e-3)) };
  }
  /** Reframe the viewport to a cell set (the `scope` property / focus_view primitive); no ids = fit all. */
  fitTo(ids?: Int32Array) { this.viewState = this.computeView(ids); this.deck.setProps({ viewState: this.viewState }); }

  setColors(rgba: Uint8Array) { this.colors = rgba; const d = this.draw, dc = this.drawColors; for (let k = 0; k < this.n; k++) { const c = d[k] * 4, o = k * 4; dc[o] = rgba[c]; dc[o + 1] = rgba[c + 1]; dc[o + 2] = rgba[c + 2]; dc[o + 3] = rgba[c + 3]; } this.colorVersion++; this.redraw(); }

  setSelection(ids: Int32Array | null) {
    this.selected.fill(0);
    if (ids) for (const i of ids) this.selected[i] = 1;
    this.selVersion++; this.redraw();
  }

  // Shift-drag rectangle select via deck.pickObjects.
  private installBrush(canvas: HTMLCanvasElement) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;border:1px dashed var(--cyan);background:var(--sel);pointer-events:none;display:none;z-index:5";
    canvas.parentElement!.appendChild(overlay); // #emb is already position:absolute (a positioning context)
    let sx = 0, sy = 0, active = false;
    const rectOf = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener("pointerdown", (e) => {
      if (!e.shiftKey) return;
      active = true; const p = rectOf(e); sx = p.x; sy = p.y;
      overlay.style.display = "block"; overlay.style.left = sx + "px"; overlay.style.top = sy + "px"; overlay.style.width = "0px"; overlay.style.height = "0px";
      canvas.setPointerCapture(e.pointerId); e.stopPropagation();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!active) return; const p = rectOf(e);
      overlay.style.left = Math.min(sx, p.x) + "px"; overlay.style.top = Math.min(sy, p.y) + "px";
      overlay.style.width = Math.abs(p.x - sx) + "px"; overlay.style.height = Math.abs(p.y - sy) + "px";
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!active) return; active = false; overlay.style.display = "none";
      const p = rectOf(e); const x = Math.min(sx, p.x), y = Math.min(sy, p.y), w = Math.abs(p.x - sx), h = Math.abs(p.y - sy);
      if (w < 3 || h < 3) return;
      const picked = (this.deck as any).pickObjects({ x, y, width: w, height: h, layerIds: ["cells"], maxObjects: 200000 });
      const ids = new Int32Array(picked.map((q: any) => this.draw[q.index]));   // pick gives draw-slot indices → map to native cells
      this.onSelect?.(ids);
    });
  }
}
