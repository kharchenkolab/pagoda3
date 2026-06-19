// Bound a weak model's "spin" — re-issuing the EXACT same tool call(s) after a "nothing to change"/rejection and
// burning the whole turn budget (seen with qwen3: 11× the identical update_view). An identical call is never
// productive (it just re-hits the same result), so we stop after it repeats. Pure + dependency-free → unit-tested;
// live.ts feeds it each turn's tool-call signature.
export interface LoopState { lastSig: string; repeats: number; }
export function newLoopState(): LoopState { return { lastSig: "", repeats: 0 }; }

// Feed the current turn's tool-call signature (name+args of every call, joined). Returns true once the SAME
// signature has appeared `limit + 1` times in a row (default: bail on the 3rd identical turn). A different
// signature resets the counter, so genuine multi-step flows (different calls each turn) never trip it.
export function isStuck(sig: string, st: LoopState, limit = 2): boolean {
  if (sig && sig === st.lastSig) st.repeats++;
  else { st.repeats = 0; st.lastSig = sig; }
  return st.repeats >= limit;
}
