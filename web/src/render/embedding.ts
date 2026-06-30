// deck.gl embedding renderer — the one panel that must scale to 10^4..10^6 points.
// Binary attributes (no per-point accessors) so coloring a million cells is a buffer swap.
import { Deck, OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer, TextLayer, LineLayer } from "@deck.gl/layers";
import { CollisionFilterExtension } from "@deck.gl/extensions";
import { themeIsDark, accentRGB } from "./theme.ts";
import { EmbeddingStyle, defaultEmbeddingStyle } from "./embedding.style.ts";

export class EmbeddingView {
  private deck: Deck;
  private positions: Float32Array;     // 2n (native cell order — picking/selection/brush use this)
  private colors: Uint8Array;          // 4n (native cell order)
  private draw!: Uint32Array;          // shuffled draw order for the cells layer (slot k → cell draw[k])
  private drawPos!: Float32Array;      // 2n positions in draw order
  private drawColors!: Uint8Array;     // 4n colours in draw order
  private selected: Uint8Array;        // n (0/1)
  private selectedIds: number[] = [];  // selected cell indices (list form) — drives the large-selection lift overlay
  private n: number;
  // every geometry/typography/opacity literal the embedding used to hardcode now lives in the resolved STYLE (set via
  // setStyle from paintEmbedding's resolvePanelStyleFor). Defaults === the former inline constants → byte-identical.
  private style: EmbeddingStyle = defaultEmbeddingStyle(themeIsDark());
  private container: HTMLElement;
  private viewState: any;
  private fitZoom = 0;   // the zoom at which the current frame fits — reference for fading the hint accent ring as you zoom OUT past it
  private frameN = 0;    // cells in the current frame (whole dataset, or the focused subset) — sizes the zoom-IN limit
  private bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };   // the current frame's data bounding box — used by clampTarget (pan bounds)
  onSelect?: (ids: Int32Array, anchor?: { left: number; top: number }) => void;   // anchor = lasso release point (px) for the selpop
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

    // deck.gl can't paint without a WebGL context. When the GPU process is wedged/disabled or contexts are
    // exhausted (e.g. many open tabs), getContext() returns null and the browser fires this event — exactly and
    // only in that case. Surface an actionable overlay instead of a silent blank panel + uncaught rejection.
    canvas.addEventListener("webglcontextcreationerror", (e: any) => this.showGlError(e && e.statusMessage), { once: true });

    this.deck = new Deck({
      canvas,
      views: [new OrthographicView({ flipY: false })],
      viewState: this.viewState,
      onViewStateChange: ({ viewState }: any) => { viewState.target = this.clampTarget(viewState.target, viewState.zoom); this.viewState = viewState; this.deck.setProps({ viewState }); return viewState; },   // PAN BOUNDS via clampTarget, RETURNED so deck uses the clamped value; zoom is bounded by the controller (below).
      controller: this.controllerProps(),
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

  // Shown when WebGL is unavailable (GPU process disabled/exhausted). One-shot, themed, actionable — turns a
  // baffling empty panel into "here's what's wrong and how to recover". The rest of the app is unaffected.
  private glFailed = false;
  private showGlError(detail?: string) {
    if (this.glFailed) return; this.glFailed = true;
    const dark = themeIsDark();
    if (getComputedStyle(this.container).position === "static") this.container.style.position = "relative";
    const box = document.createElement("div");
    box.className = "gl-error";
    box.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font:13px/1.55 system-ui,sans-serif;z-index:5;background:" + (dark ? "rgba(18,18,22,.88)" : "rgba(250,250,252,.92)") + ";color:" + (dark ? "#ddd" : "#333");
    box.innerHTML =
      '<div style="max-width:440px">' +
      '<div style="font-size:15px;font-weight:600;margin-bottom:8px">Can’t render the embedding</div>' +
      '<div style="opacity:.85">Your browser couldn’t create a WebGL context — its GPU process is disabled or out of contexts. The rest of the app works; this panel needs WebGL.</div>' +
      '<div style="opacity:.72;margin-top:10px">Fix: <b>fully quit &amp; reopen your browser</b> (not just reload), close other heavy tabs, or check <code>chrome://gpu</code>.</div>' +
      (detail ? '<div style="opacity:.45;margin-top:10px;font-size:11px">' + String(detail).replace(/[<>&]/g, "") + "</div>" : "") +
      "</div>";
    this.container.appendChild(box);
  }

  private layers() {
    const s = this.style;   // resolved style — geometry/typography/opacity read from here, not inline literals
    // HINT presentation. DEFAULT 'lift' draws EVERY hinted cell as two stacked layers — and lets DRAW ORDER do the work:
    //   • an accent RING just outside each cell (one consistent highlight colour), drawn UNDER,
    //   • the cell's OWN-COLOUR FILL drawn ON TOP (the value "within").
    // Spread out (zoom-in), each cell shows its value with an accent halo around it. As the cloud PACKS (zoom-out), the
    // own-colour fills — drawn last — cover the rings, so the VALUES dominate and the accent recedes on its own. No cap
    // (every cell is ringed when there's room), no zoom hack. 'ring' = hollow accent only; 'fill' = accent disc.
    const nHint = this.highlightIds ? this.highlightIds.length : 0;
    const hmode = s.hint.mode === "adaptive" ? (nHint && nHint <= s.hint.ringThreshold ? "ring" : "lift") : s.hint.mode;
    const baseOpacity = (nHint && hmode === "lift") ? s.point.opacity * s.hint.dim : s.point.opacity;
    const all = this.highlightIds;
    const hintLayers: any[] = [];
    if (all && nHint) {
      const acc = accentRGB(), fillR = s.point.radius + s.hint.grow;
      const pos = (_: any, { index }: any): [number, number] => { const c = all[index]; return [this.positions[c * 2], this.positions[c * 2 + 1]]; };
      const accentLayer = (id: string, r: number, hollow: boolean) => new ScatterplotLayer({
        id, data: { length: nHint }, getPosition: pos, radiusUnits: "pixels", getRadius: r, opacity: 1,
        filled: !hollow, stroked: hollow, getFillColor: [...acc, s.hint.opacity],
        lineWidthUnits: "pixels", getLineWidth: s.hint.ring, getLineColor: [...acc, s.hint.opacity],
        updateTriggers: { getPosition: this.hintVersion },
      }) as any;
      const ownFill = new ScatterplotLayer({   // the VALUES — own colours, drawn LAST so the topmost cells always read clearly, even packed
        id: "hl-fill", data: { length: nHint }, getPosition: pos, radiusUnits: "pixels", getRadius: fillR, stroked: false, opacity: 1,
        getFillColor: (_: any, { index }: any) => { const c = all[index]; return [this.colors[c * 4], this.colors[c * 4 + 1], this.colors[c * 4 + 2], 255]; },
        updateTriggers: { getPosition: this.hintVersion, getFillColor: [this.hintVersion, this.colorVersion] },
      }) as any;
      if (hmode === "lift") hintLayers.push(accentLayer("hl-ring", fillR + 1.2, true), ownFill);   // ring UNDER + own fill ON TOP
      else if (hmode === "ring") hintLayers.push(accentLayer("hl-ring", fillR, true));             // hollow accent only
      else hintLayers.push(accentLayer("hl-disc", fillR, false));                                  // accent disc
    }
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
        getRadius: s.point.radius,
        radiusMinPixels: s.point.minPixels,
        stroked: false,
        pickable: true,
        opacity: baseOpacity,                     // <1 lets overlapping cells convey density; dimmed further under a live hint
        updateTriggers: { all: this.colorVersion },
      }) as any,
      // SELECTION on TOP — the rest is receded toward the background (in the per-cell colours), so re-draw the selected
      // cells last, in their OWN colours at FULL alpha and opacity 1 (a touch larger), so they sit crisp above the
      // de-emphasised mass and can never be occluded by it. Identity is carried by colour+luminance contrast, not a ring.
      this.selCount() > 0
        ? new ScatterplotLayer({
            id: "seltop",
            data: { length: this.selectedIds.length },
            getPosition: (_: any, { index }: any) => { const c = this.selectedIds[index]; return [this.positions[c * 2], this.positions[c * 2 + 1]]; },
            getFillColor: (_: any, { index }: any) => { const c = this.selectedIds[index]; return [this.colors[c * 4], this.colors[c * 4 + 1], this.colors[c * 4 + 2], 255]; },
            radiusUnits: "pixels", getRadius: s.point.radius + s.selection.fillGrow, stroked: false, opacity: 1,
            updateTriggers: { getPosition: this.selVersion, getFillColor: [this.selVersion, this.colorVersion] },
          }) as any
        : null,
      // CATEGORY hint (see hintLayers above): own-colour FILLS show the values "within" + a SPARSE accent-ring spray
      // gives one consistent highlight colour that can't haze — both survive any zoom because the rings are capped and
      // the fills are the cells' own colours (never occlude).
      ...hintLayers,
      // CELL hint → full-panel crosshairs intersecting at the cell (precise "you are here", any zoom)
      this.crosshairXY
        ? new LineLayer({
            id: "crosshair",
            data: [{ s: [this.crosshairXY[0], -1e5], t: [this.crosshairXY[0], 1e5] }, { s: [-1e5, this.crosshairXY[1]], t: [1e5, this.crosshairXY[1]] }],
            getSourcePosition: (d: any) => d.s, getTargetPosition: (d: any) => d.t,
            getColor: [...accentRGB(), s.crosshair.opacity], widthUnits: "pixels", getWidth: s.crosshair.width,
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
            getSize: s.label.fontSize, sizeUnits: "pixels", sizeMinPixels: s.label.minPixels, sizeMaxPixels: s.label.maxPixels,
            getColor: s.label.textColor, getTextAnchor: "middle", getAlignmentBaseline: "center",   // theme-aware default; overridable via style.label.textColor
            fontFamily: s.label.fontFamily, fontWeight: s.label.weight,
            // NON-SDF bitmap atlas (large fontSize, downscaled) — crisper for fixed-pixel labels than SDF, which
            // rendered fuzzy in Chrome. No outline halo (it caused the white-pixel fringe) — the backing plate below
            // carries the contrast instead: a soft panel-coloured rectangle (low alpha so it doesn't obscure cells).
            fontSettings: { sdf: false, fontSize: s.label.atlasFontSize, buffer: 4 },
            background: true, getBackgroundColor: s.label.bgColor, backgroundPadding: s.label.padding,
            billboard: true, pickable: false, characterSet: "auto",
            extensions: [new CollisionFilterExtension()],
            collisionEnabled: true, collisionGroup: "labels",
            // inflate the hit-box so kept labels keep clear air. sizeMaxPixels must be raised here too,
            // else the base layer's 15px clamp cancels the scale-up and nothing gets decluttered.
            collisionTestProps: { sizeScale: s.label.collisionScale, sizeMaxPixels: s.label.collisionMaxPixels },
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

  /** Release the GL context + animation loop — called when the app is torn down (e.g. opening a new
   *  local dataset) so a removed canvas's deck doesn't keep ticking. */
  finalize(): void { try { (this.deck as any).finalize?.(); } catch { /* already gone */ } }

  /** Show (or clear) a subtle locator ring at a data-space point — the cross-panel hover cue. */
  /** CELL hint: crosshairs at cell `i` in THIS panel's embedding (null clears). Each panel resolves the same
   *  cell to its own coords — so hovering a cell marks it in the before AND after embeddings at once. */
  setCrosshairCell(i: number | null) { this.crosshairXY = i == null ? null : [this.positions[i * 2], this.positions[i * 2 + 1]]; this.hintVersion++; this.redraw(); }
  /** CATEGORY hint: lift a set of cells as a light overlay (null clears). */
  setHighlightCells(ids: Int32Array | null) { this.highlightIds = ids; this.hintVersion++; this.redraw(); }

  /** Point opacity for the cells layer — <1 reveals density through overlap. (Alias into the style spec.) */
  setAlpha(a: number) { if (a === this.style.point.opacity || !(a > 0)) return; this.style.point.opacity = a; this.redraw(); }

  /** Apply the resolved per-panel STYLE (geometry/typography/opacity). Rebuilds the layers, so every knob takes effect
   *  on the next paint. Bumps colorVersion so the cells layer re-reads its radius/opacity attributes. */
  setStyle(s: EmbeddingStyle) { this.style = s; this.colorVersion++; this.labelVersion++; this.redraw(); }

  /** Place category names at their centroids (categorical colouring); pass [] to clear (numeric colouring). */
  setLabels(labels: { text: string; p: [number, number]; priority: number }[]) { this.labels = labels; this.labelVersion++; this.redraw(); }

  /** A view state (target + zoom) that frames a cell SET — or all cells when ids is empty/undefined. */
  private computeView(ids?: Int32Array): any {
    const emb = this.positions, count = ids && ids.length ? ids.length : this.n;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < count; k++) { const i = ids && ids.length ? ids[k] : k; const x = emb[i * 2], y = emb[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1, rect = this.container.getBoundingClientRect();
    const ppu = Math.min((rect.width || 800) / spanX, (rect.height || 600) / spanY) * this.style.fit.pad;
    this.frameN = count;   // cells in THIS frame (the subset when scoped) — sizes the zoom-IN limit so a focused subpopulation can't zoom past ~2 points
    this.fitZoom = Math.log2(Math.max(ppu, 1e-3));   // remember the fit scale → the hint ring fades when zoomed OUT past it
    this.bounds = { minX, maxX, minY, maxY };
    return { target: [(minX + maxX) / 2, (minY + maxY) / 2, 0], zoom: this.fitZoom };
  }
  /** Reframe the viewport to a cell set (the `scope` property / focus_view primitive); no ids = fit all. */
  // The controller's zoom bounds for the CURRENT frame: minZoom = fit (the wheel can't pull OUT past all-cells),
  // maxZoom ≈ fit + log2(√frameN / 2) (can't zoom IN past ~2 points across the frame). deck.gl enforces these during
  // interaction (unlike an onViewStateChange clamp). Re-applied on fitTo() since fit/frameN change with the subset.
  // PAN BOUNDS: clamp the view target so the data cloud can't be dragged out of frame. When the box fits the
  // window (zoomed out) the target stays near centre; zoomed IN past the box, the window stays inside it.
  // RETURNED from onViewStateChange so deck USES it (a setProps clamp races the controller and loses — see zoom).
  private clampTarget(target: any, zoom: number): number[] {
    const rect = this.container.getBoundingClientRect();
    const scale = Math.pow(2, zoom), halfW = (rect.width || 800) / 2 / scale, halfH = (rect.height || 600) / 2 / scale;
    const b = this.bounds, cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    // dev = how far the target may leave the centroid. Zoomed OUT (window >= span): just (halfW - halfSpan), so the box
    // stays fully in frame (all cells visible). Zoomed IN (window < span): (halfSpan - halfW) would pin a data edge flush
    // to the viewport border — too stringent; add a margin of M·viewport so an extreme cell can sit comfortably IN from
    // the edge. M is the only knob (0 = old behaviour; higher = more pan slack / more empty space allowed when zoomed in).
    const M = 0.2;
    const dev = (half: number, halfSpan: number) => half >= halfSpan ? (half - halfSpan) : (halfSpan - half) + M * 2 * half;
    const dx = dev(halfW, (b.maxX - b.minX) / 2), dy = dev(halfH, (b.maxY - b.minY) / 2);
    return [Math.max(cx - dx, Math.min(cx + dx, target[0])), Math.max(cy - dy, Math.min(cy + dy, target[1])), target[2] || 0];
  }
  private controllerProps() { return { dragPan: true, scrollZoom: true, doubleClickZoom: false, minZoom: this.fitZoom, maxZoom: this.fitZoom + Math.log2(Math.max(2, Math.sqrt(this.frameN || this.n) / 2)) }; }
  fitTo(ids?: Int32Array) { this.viewState = this.computeView(ids); this.deck.setProps({ viewState: this.viewState, controller: this.controllerProps() }); }

  setColors(rgba: Uint8Array) { this.colors = rgba; const d = this.draw, dc = this.drawColors; for (let k = 0; k < this.n; k++) { const c = d[k] * 4, o = k * 4; dc[o] = rgba[c]; dc[o + 1] = rgba[c + 1]; dc[o + 2] = rgba[c + 2]; dc[o + 3] = rgba[c + 3]; } this.colorVersion++; this.redraw(); }

  setSelection(ids: Int32Array | null) {
    this.selected.fill(0);
    this.selectedIds = ids ? Array.from(ids) : [];   // kept as a list so the large-selection lift layer iterates only selected cells
    if (ids) for (const i of ids) this.selected[i] = 1;
    this.selVersion++; this.redraw();
  }

  // Shift-drag freehand LASSO select — far more useful than a rectangle for irregular cluster shapes. The path is
  // collected in screen px; on release each cell's world position is PROJECTED to screen (via the deck viewport) and
  // tested point-in-polygon (bbox-culled first). Native cell indices → onSelect.
  private installBrush(canvas: HTMLCanvasElement) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none;z-index:5;overflow:visible");
    const poly = document.createElementNS(NS, "polygon");
    poly.setAttribute("fill", "var(--sel)"); poly.setAttribute("stroke", "var(--cyan)"); poly.setAttribute("stroke-width", "1.4"); poly.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(poly); canvas.parentElement!.appendChild(svg);   // #emb is position:absolute (a positioning context)
    let path: [number, number][] = [], active = false;
    const at = (e: PointerEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const render = () => poly.setAttribute("points", path.map((p) => p.join(",")).join(" "));
    canvas.addEventListener("pointerdown", (e) => {
      if (!e.shiftKey) return;
      active = true; path = [at(e)]; svg.style.display = "block"; render();
      canvas.setPointerCapture(e.pointerId); e.stopPropagation();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!active) return; const p = at(e), last = path[path.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 3) { path.push(p); render(); }   // decimate to keep the polygon small
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!active) return; active = false; svg.style.display = "none";
      if (path.length < 3) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of path) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      if (maxX - minX < 3 || maxY - minY < 3) return;
      const vp = (this.deck as any).getViewports?.()[0]; if (!vp) return;
      const ids: number[] = [];
      for (let i = 0; i < this.n; i++) {
        const s = vp.project([this.positions[i * 2], this.positions[i * 2 + 1]]); const sx = s[0], sy = s[1];
        if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;   // bbox cull before the polygon test
        if (pointInPolygon(sx, sy, path)) ids.push(i);
      }
      if (ids.length) this.onSelect?.(Int32Array.from(ids), { left: e.clientX, top: e.clientY });   // anchor the selpop at the lasso release point
    });
  }
}

// ray-casting point-in-polygon (screen-space px)
function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
