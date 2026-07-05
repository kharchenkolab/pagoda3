// Tool-trust for a LINK-ORIGIN ask (the ?ask= deep-link auto-run). A re-shared deep link must not be able to run
// arbitrary JS, author/mount a widget, or fetch a URL unprompted — so a link-origin turn is offered only the SAFE
// subset of tools: the full VIEW + COMPUTE surface (colour/panels/focus/layout, de/pseudobulk/overdispersion/
// markers/composition, categories, annotation) stays — all reversible — while the code-executing / external tools
// are withheld. If a directive genuinely needs code, the agent says so and the user re-asks manually (a typed ⌘K
// ask gets the complete toolset). Pure + dependency-free so it's unit-testable without the browser-coupled live.ts.

/** Tool names withheld from a link-origin auto-ask: they execute code (compute_code, the widget author/preview/
 *  save/edit/inspect suite) or reach outside the app (fetch_url). Everything else is view/compute and reversible. */
export const CODE_TOOLS = new Set<string>([
  "compute_code", "fetch_url",
  "read_widget_contract", "get_widget_template", "find_widget_recipe", "list_widget_recipes",
  "get_widget_recipe", "list_widget_capabilities", "preview_widget", "edit_widget", "save_widget", "inspect_widget",
]);

/** The tools offered to the model: the full list, or (for a link-origin auto-ask) the safe subset with the
 *  code-executing / external tools removed. */
export function filterTools<T extends { name: string }>(tools: T[], restrictCode?: boolean): T[] {
  return restrictCode ? tools.filter((t) => !CODE_TOOLS.has(t.name)) : tools;
}
