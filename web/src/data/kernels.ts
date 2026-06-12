// Lazy loader for the real libstar WASM kernels (built from the same C++ core that backs the
// R and Python packages — so the browser's numbers match). Served at /wasm/lstar_kernels.mjs
// (copied from lstar/js/dist by the vite plugin). Returns null if unavailable; callers then
// use their pure-TS fallback.
let kernelsP: Promise<any | null> | null = null;

export function kernels(): Promise<any | null> {
  if (kernelsP === null) {
    kernelsP = (async () => {
      try {
        const url = new URL("/wasm/lstar_kernels.mjs", location.origin).href;
        const mod: any = await import(/* @vite-ignore */ url);
        const M = await mod.default();
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
