export function mk(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
export function S(tag: string, attrs: Record<string, any>): SVGElement {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}
export const $ = (id: string) => document.getElementById(id)!;
