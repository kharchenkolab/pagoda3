// Named colour palettes for numeric colourings (embedding colour-by gene/qc/score, etc.). Pure + dependency-free
// (node --test loads it), so the reducer can validate a colormap name and the paint layer can resolve it from the
// same source of truth. A palette is a function t∈[0,1] → [r,g,b]; `amber` reproduces the original fixed ramp.

export type Palette = (t: number) => [number, number, number];

function ramp(stops: number[][]): Palette {
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.floor(x), f = x - i, a = stops[i], b = stops[Math.min(stops.length - 1, i + 1)];
    return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
  };
}

const RDBU = [[178, 24, 43], [239, 138, 98], [253, 219, 199], [247, 247, 247], [209, 229, 240], [103, 169, 207], [33, 102, 172]]; // low red → high blue

export const PALETTES: Record<string, Palette> = {
  amber: ramp([[27, 34, 48], [224, 164, 88]]),                                                  // the original fixed ramp (default)
  viridis: ramp([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]]),   // perceptually uniform
  magma: ramp([[0, 0, 4], [81, 18, 124], [183, 55, 121], [252, 137, 97], [252, 253, 191]]),
  rdbu: ramp(RDBU),                                                                              // diverging: red (low) → blue (high)
  bluered: ramp([...RDBU].reverse()),                                                            // diverging: blue (low) → red (high)
  blues: ramp([[247, 251, 255], [198, 219, 239], [107, 174, 214], [33, 113, 181], [8, 48, 107]]),
  greys: ramp([[245, 245, 245], [20, 20, 20]]),
};

// user/agent spelling → canonical name (after stripping case, spaces, dashes, underscores)
const ALIASES: Record<string, string> = {
  amber: "amber", default: "amber", fire: "amber",
  viridis: "viridis",
  magma: "magma", inferno: "magma",
  rdbu: "rdbu", redblue: "rdbu", redtoblue: "rdbu", rdtobu: "rdbu",
  bluered: "bluered", bluetored: "bluered", bwr: "bluered", coolwarm: "bluered",
  blues: "blues", blue: "blues",
  greys: "greys", grays: "greys", grey: "greys", gray: "greys",
};

/** Canonical palette name for an arbitrary user/agent spelling, or null if unknown. */
export function normalizePalette(name: string): string | null {
  if (typeof name !== "string") return null;
  return ALIASES[name.toLowerCase().replace(/[\s_-]+/g, "")] || null;
}

/** The canonical palette names (for tool descriptions / UI menus). */
export function paletteNames(): string[] { return Object.keys(PALETTES); }
