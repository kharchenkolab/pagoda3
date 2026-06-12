// deck.gl embedding renderer — the one panel that must scale to 10^4..10^6 points.
// Binary attributes (no per-point accessors) so coloring a million cells is a buffer swap.
import { Deck, OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";

export class EmbeddingView {
  private deck: Deck;
  private positions: Float32Array;     // 2n
  private colors: Uint8Array;          // 4n
  private selected: Uint8Array;        // n (0/1)
  private n: number;
  private radius = 2.4;
  onSelect?: (ids: Int32Array) => void;

  constructor(container: HTMLElement, emb: Float32Array, n: number) {
    this.n = n;
    this.positions = emb;
    this.colors = new Uint8Array(n * 4).fill(180);
    for (let i = 0; i < n; i++) this.colors[i * 4 + 3] = 230;
    this.selected = new Uint8Array(n);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = emb[i * 2], y = emb[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
    const rect = container.getBoundingClientRect();
    const ppu = Math.min((rect.width || 800) / spanX, (rect.height || 600) / spanY) * 0.86;
    const zoom = Math.log2(Math.max(ppu, 1e-3));

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%"; canvas.style.height = "100%"; canvas.style.display = "block";
    container.appendChild(canvas);

    this.deck = new Deck({
      canvas,
      views: [new OrthographicView({ flipY: false })],
      initialViewState: { target: [cx, cy, 0], zoom },
      controller: { dragPan: true, scrollZoom: true, doubleClickZoom: false },
      layers: this.layers(),
    });

    this.installBrush(canvas);
  }

  private layers() {
    return [
      new ScatterplotLayer({
        id: "cells",
        data: {
          length: this.n,
          attributes: {
            getPosition: { value: this.positions, size: 2 },
            getFillColor: { value: this.colors, size: 4 },
          },
        },
        radiusUnits: "pixels",
        getRadius: this.radius,
        radiusMinPixels: 1,
        stroked: false,
        pickable: true,
        updateTriggers: { all: this.colorVersion },
      }) as any,
      // selection halo
      this.selCount() > 0
        ? new ScatterplotLayer({
            id: "sel",
            data: { length: this.n },
            getPosition: (_: any, { index }: any) => (this.selected[index] ? [this.positions[index * 2], this.positions[index * 2 + 1]] : [1e9, 1e9]),
            radiusUnits: "pixels", getRadius: this.radius + 1.6,
            stroked: true, filled: false, getLineColor: [92, 200, 255, 255], lineWidthUnits: "pixels", getLineWidth: 1.2,
            updateTriggers: { getPosition: this.selVersion },
          }) as any
        : null,
      // ephemeral hover locator — a subtle ring at the centroid of a hinted group (cross-panel cue)
      this.hintXY
        ? new ScatterplotLayer({
            id: "hint", data: [{ p: this.hintXY }], getPosition: (d: any) => d.p,
            radiusUnits: "pixels", getRadius: 15, stroked: true, filled: false,
            getLineColor: [150, 225, 255, 220], lineWidthUnits: "pixels", getLineWidth: 1.8,
            updateTriggers: { getPosition: this.hintVersion },
          }) as any
        : null,
      // on-plot category labels at centroids — names ON the map, so orientation isn't swatch-matching.
      // Drawn last (on top); halo'd so they read over any cluster colour. Cleared for numeric colourings.
      this.labels.length
        ? new TextLayer({
            id: "labels", data: this.labels,
            getPosition: (d: any) => d.p, getText: (d: any) => d.text,
            getSize: 12.5, sizeUnits: "pixels", sizeMinPixels: 10, sizeMaxPixels: 15,
            getColor: [240, 244, 250, 255], getTextAnchor: "middle", getAlignmentBaseline: "center",
            fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif", fontWeight: 700,
            fontSettings: { sdf: true, radius: 14, buffer: 6 }, outlineWidth: 2.4, outlineColor: [9, 13, 20, 255],
            billboard: true, pickable: false, characterSet: "auto",
            updateTriggers: { getText: this.labelVersion, getPosition: this.labelVersion },
          }) as any
        : null,
    ].filter(Boolean);
  }

  private colorVersion = 0;
  private selVersion = 0;
  private hintXY: [number, number] | null = null;
  private hintVersion = 0;
  private labels: { text: string; p: [number, number] }[] = [];
  private labelVersion = 0;
  private selCount() { let c = 0; for (let i = 0; i < this.n; i++) c += this.selected[i]; return c; }
  private redraw() { this.deck.setProps({ layers: this.layers() }); }

  /** Show (or clear) a subtle locator ring at a data-space point — the cross-panel hover cue. */
  setHint(xy: [number, number] | null) { this.hintXY = xy; this.hintVersion++; this.redraw(); }

  /** Place category names at their centroids (categorical colouring); pass [] to clear (numeric colouring). */
  setLabels(labels: { text: string; p: [number, number] }[]) { this.labels = labels; this.labelVersion++; this.redraw(); }

  setColors(rgba: Uint8Array) { this.colors = rgba; this.colorVersion++; this.redraw(); }

  setSelection(ids: Int32Array | null) {
    this.selected.fill(0);
    if (ids) for (const i of ids) this.selected[i] = 1;
    this.selVersion++; this.redraw();
  }

  // Shift-drag rectangle select via deck.pickObjects.
  private installBrush(canvas: HTMLCanvasElement) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;border:1px dashed #5cc8ff;background:rgba(92,200,255,.12);pointer-events:none;display:none;z-index:5";
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
      const ids = new Int32Array(picked.map((q: any) => q.index));
      this.onSelect?.(ids);
    });
  }
}
