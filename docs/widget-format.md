# Portable widget file (`pagoda-widget`)

A **widget** (a custom "app") in lstar-viewer can be exported to a single self-describing
JSON file and re-imported on another machine or by another user. This is the unit of
**reuse and sharing** for widgets — distinct from the whole-session bundle
(`pagoda-session`), which carries the layout, results, annotation, and the entire widget
library at once.

The format and its helpers are pure and node-testable, in
[`web/src/ui/persist.ts`](../web/src/ui/persist.ts) (`serializeWidgetFile`,
`parseWidgetFile`, `widgetNeeds`); tests in
[`web/src/ui/persist.test.ts`](../web/src/ui/persist.test.ts). Wiring (export/import) is in
`web/src/ui/shell.ts`.

## File shape

```json
{
  "kind": "pagoda-widget",
  "v": 2,
  "name": "Ranked bar chart",
  "source": "pagoda.ready({title:'Ranked bars', params:[…]}); … widget JS …",
  "controls": [{ "id": "topN", "label": "Top N" }],
  "needs": { "libs": ["3dmol"], "external": ["data.rcsb.org"] },
  "savedAt": 1719700000000
}
```

| field      | meaning |
|------------|---------|
| `kind`     | always `"pagoda-widget"` — how a reader tells it apart from a `pagoda-session` bundle. |
| `v`        | format version (shared with the session file). |
| `name`     | library key / display name. The only piece of identity not in `source`. |
| `source`   | the widget's JavaScript. **This is the whole widget.** Its capability manifest (title, params, permissions, version) is declared *inside* it via `pagoda.ready({…})`. |
| `controls` | cached header controls (re-derivable from the manifest; carried so the library shows them without mounting). |
| `needs`    | **derived** dependency contract — see below. Re-computed on parse if absent or malformed; never trusted from a hand-edited file. |
| `savedAt`  | epoch ms the file was written. |

## Why a JSON wrapper and not raw `.js`

The widget's *capabilities* are already self-describing in `source` (the in-code manifest).
The wrapper exists to carry what the code **can't**: the `name`, a format `version`, and —
most usefully — a surfaced **dependency contract** (`needs`) so a recipient can see what a
widget requires *before* trusting and running it. A bare `.js` gives you the code but none
of that, and there's no clean way to re-import it.

## Self-containment model

A widget is **self-contained as code** — all of its own logic is in the one `source` — but
its runtime **dependencies are externalized by reference, not bundled**. The widget runs in a
sandboxed iframe that **cannot** `fetch()`, `import`, or load a CDN `<script>` directly.
Everything external goes through the host, by name:

- **`pagoda.loadLib(name)`** — loads a curated, version-**pinned** library the host injects.
  The registry is the allowlist in [`server/proxy.mjs`](../server/proxy.mjs) (`LIB_REGISTRY`,
  e.g. `3dmol`, `d3`). The widget references `loadLib('3dmol')`; it does **not** contain 3Dmol.
- **`pagoda.fetchExternal(url)`** — host-proxied, allowlisted external **biodata** fetch
  (rcsb, uniprot, ensembl, …). Declared in the manifest's `permissions.external`.

Consequence: **even a heavy widget is a small file.** A 3-D molecular viewer is just glue —
`loadLib('3dmol')` + `fetchExternal(PDB)` + render. The library (and any WASM inside it) lives
on the **host**, served from `/api/lib`, never in the widget.

### Portability is bounded by host parity, not file size

A shared widget runs only where the destination host **pins the same `loadLib` names** and
**allows the same `fetchExternal` hosts**. That's exactly what `needs` makes visible: import
surfaces it ("libs: 3dmol · fetches: data.rcsb.org"), and a future host-registry check can turn
"needs a lib your host doesn't pin" into a clear, fixable message instead of a runtime failure.

### WASM

Libraries are never bundled, so any WASM lives in a host-pinned lib loaded at runtime — the
widget file stays kilobytes regardless of visual complexity. A fully offline widget *could*
base64-inline its own WASM and `WebAssembly.instantiate` it with no network (still one file,
just large), but that's against the grain — the design pushes weight to the pinned host libs.

## The `needs` dependency contract

`widgetNeeds(source, declaredExternal?)` is a **static, source-only** scan:

- `libs` — every `loadLib('x')` string literal.
- `external` — the host of every `fetchExternal('https://host/…')` **plain-quoted** literal,
  plus any hosts passed in `declaredExternal` (the manifest's declared hosts, when the caller
  has them).

**Limitations (by design):** only string-literal arguments are caught. A dynamic
`loadLib(name)` or a templated `` fetchExternal(`https://${host}/…`) `` won't appear — those
aren't statically knowable. The widget **lint** already nudges authors to declare
`permissions.external` for every host they fetch, so the declared list is the backstop for the
dynamic cases.

## Export / import behaviour

- **Export** — the Session ledger's row action ⤓ on a widget writes
  `pagoda-widget-<name>.json` (this replaced the old raw-`.js` export; the source is still
  inside, in `source`).
- **Import** — the Session panel's header ⤒ (and the account-menu import) accept a `.json`
  that is **either** a session bundle **or** a widget file; it branches on `kind`. A widget
  file is dataset-agnostic, so it just joins the library:
  - upserted with **`origin: "imported"`**, so it appears in **Add to workbench** and its panel
    renders the **consent gate** before the code ever runs (the trust list is
    content-addressed, so re-importing source you already trusted stays trusted);
  - the import toast surfaces `needs`.

## Future: standalone sandbox

A standalone authoring/refinement sandbox would read and write **this same** `pagoda-widget`
format, so a widget flows sandbox → file → viewer (and back) with no translation. Designing the
file now means the sandbox inherits the dependency contract for free.
