// CellTypist inference, in-browser. CellTypist models ARE logistic regression — a weight matrix (genes ×
// classes, from sklearn .coef_) + intercepts. Prediction = softmax(X·W + b) per cell, argmax → label. One
// matmul; no server. Shipping a TRAINED model means converting CellTypist's .pkl to the LRModel shape below
// (model.genes, model.classes, model.coef_, model.intercept_) — a data asset / pipeline step, not code.
export interface LRModel { genes: string[]; classes: string[]; W: Float32Array; b: Float32Array }   // W = [nGenes × nClasses] row-major
export interface LRResult { codes: Int32Array; conf: Float32Array }                                  // per cell: argmax class + its probability

// softmax + argmax over each row of a [N × C] logits buffer → predicted class + its probability.
export function lrFinalize(logits: Float64Array, N: number, C: number): LRResult {
  const codes = new Int32Array(N), conf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const b = i * C; let mx = -Infinity, arg = 0;
    for (let c = 0; c < C; c++) { const v = logits[b + c]; if (v > mx) { mx = v; arg = c; } }
    let s = 0; for (let c = 0; c < C; c++) s += Math.exp(logits[b + c] - mx);
    codes[i] = arg; conf[i] = 1 / s;   // exp(max-max)/Σ = probability of the winning class
  }
  return { codes, conf };
}

// Dense reference forward pass (for tests + small models). X = [nCells × nGenes] row-major, model-gene order.
// The app runner uses a SPARSE accumulation (gene-by-gene) instead, to avoid materializing a huge dense X.
export function predictLR(X: Float32Array, N: number, model: LRModel): LRResult {
  const G = model.genes.length, C = model.classes.length;
  const logits = new Float64Array(N * C);
  for (let i = 0; i < N; i++) {
    const lb = i * C, xb = i * G;
    for (let c = 0; c < C; c++) logits[lb + c] = model.b[c];
    for (let g = 0; g < G; g++) { const x = X[xb + g]; if (!x) continue; const wb = g * C; for (let c = 0; c < C; c++) logits[lb + c] += x * model.W[wb + c]; }
  }
  return lrFinalize(logits, N, C);
}
