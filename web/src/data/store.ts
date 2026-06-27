// The app's L* reader is now the canonical @lstar/core package — a single source of truth, so the reader
// no longer drifts from the format. We import the package's reader.ts / http-store.ts directly (tsconfig
// already includes ../../lstar/js/core and vite allows the path), matching the WASM-kernel copy pattern.
// HttpStore adds the byte-range fast path + the consolidated `.zmetadata` open (one request, not ~80).
export { openLstar, LstarDataset } from "../../../../lstar/js/core/reader.ts";
export type { AxisMeta, FieldMeta, LstarStore } from "../../../../lstar/js/core/reader.ts";
export { HttpStore } from "../../../../lstar/js/core/http-store.ts";
