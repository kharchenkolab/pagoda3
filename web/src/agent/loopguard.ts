// Bound a weak model's "spin" — re-issuing the EXACT same tool call(s) after a "nothing to change"/rejection and
// burning the whole turn budget (seen with qwen3: 11× the identical update_view). A repeated call that keeps
// BOUNCING (rejection/no-change) is never productive, so we stop after it repeats. Pure + dependency-free →
// unit-tested; live.ts feeds it each turn's signature + whether the turn made progress.
export interface LoopState { lastSig: string; repeats: number; }
export function newLoopState(): LoopState { return { lastSig: "", repeats: 0 }; }

// Feed the current turn's tool-call signature (name+args of every call, joined) + whether the turn made PROGRESS
// (it applied/changed something, vs bounced off a rejection/no-change/error). Returns true once the SAME signature
// has repeated `limit + 1` times in a row WITHOUT progress. A different sig — OR a turn that DID make progress —
// resets the counter. The progress check matters for STATEFUL actions (triggering a widget control N times, or any
// "do X again"): the call is byte-identical yet productive, so it must NOT be mistaken for a spin. Only an identical
// call that keeps bouncing (the qwen "nothing to change" loop) trips. progressed defaults false → legacy behaviour.
export function isStuck(sig: string, st: LoopState, progressed = false, limit = 2): boolean {
  if (progressed || !sig || sig !== st.lastSig) { st.repeats = 0; st.lastSig = sig; return false; }
  st.repeats++;
  return st.repeats >= limit;
}
