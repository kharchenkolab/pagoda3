// Lazy loader for the real libstar WASM kernels (built from the same C++ core that backs the
// R and Python packages — so the browser's numbers match). Loaded via a STATIC import so the
// bundler resolves the .mjs + .wasm relative to the app's own base — works at any mount path
// (root, /pagoda3/, a deploy subpath, or behind an OOD reverse proxy); an origin-absolute
// /wasm/ URL would break wherever the app isn't served at the site root. Returns null if
// unavailable; callers then use their pure-TS fallback.
import createLstarKernels from "../../../../lstar/js/dist/lstar_kernels.mjs";

let kernelsP: Promise<any | null> | null = null;

export function kernels(): Promise<any | null> {
  if (kernelsP === null) {
    kernelsP = (async () => {
      try {
        const M = await createLstarKernels();
        console.info("[lstar] WASM kernels:", M.version());
        return M;
      } catch (e) {
        console.warn("[lstar] WASM kernels unavailable — pure-TS fallback", e);
        return null;
      }
    })();
  }
  return kernelsP;
}
