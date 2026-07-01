// Minimal, XSS-safe Markdown → HTML for agent chat bubbles. The live agent writes Markdown (**bold**, `code`,
// `- ` lists, | tables |); rendered raw it showed the literal syntax. Strategy: pull out code spans first (their
// content is escaped, never markdown-processed), escape ALL html in the rest, then restore a small whitelist of
// simple inline tags a few built-in messages already use (<b> <i> <em> <strong> <code> <br>), then render the
// block/inline markdown. Nothing else (scripts, attributes, event handlers, <img>) can pass through.

const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NUL = String.fromCharCode(0);   // null-byte placeholder delimiter for extracted code spans — can't occur in real chat text

// inline formatting on already-escaped text (code spans are placeholders, restored later)
function inline(s: string): string {
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");           // *italic* (after **bold**)
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");        // _italic_ (not snake_case)
  return s;
}

export function mdToHtml(src: string | null | undefined): string {
  if (!src) return "";
  const codes: string[] = [];
  const ph = () => NUL + (codes.length - 1) + NUL;
  const s = String(src)
    .replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_, c) => { codes.push(`<pre class="mdpre"><code>${escHtml(String(c).replace(/\n$/, ""))}</code></pre>`); return ph(); })
    .replace(/`([^`\n]+)`/g, (_, c) => { codes.push(`<code class="mdcode">${escHtml(c)}</code>`); return ph(); });
  const t = escHtml(s).replace(/&lt;(\/?)(b|i|em|strong|code|br)\s*\/?&gt;/gi, "<$1$2>");
  const lines = t.split("\n");
  const isSep = (l: string) => l.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(l);
  const cells = (row: string) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => inline(c.trim()));
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {   // table
      const head = cells(l); i += 2; const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      out.push(`<table class="mdtable"><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const ol = /^\s*\d+\.\s+/.test(l), ul = /^\s*[-*]\s+/.test(l);
    if (ol || ul) {   // list
      const re = ol ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/; const items: string[] = [];
      while (i < lines.length) { const m = lines[i].match(re); if (!m) break; items.push(`<li>${inline(m[1])}</li>`); i++; }
      out.push(`<${ol ? "ol" : "ul"} class="mdlist">${items.join("")}</${ol ? "ol" : "ul"}>`);
      continue;
    }
    const hm = l.match(/^\s*#{1,6}\s+(.*)$/);
    if (hm) { out.push(`<div class="mdh">${inline(hm[1])}</div>`); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const para: string[] = [];   // consecutive plain lines → one paragraph, soft-wrapped
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]\s|\d+\.\s|#{1,6}\s)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isSep(lines[i + 1]))) { para.push(inline(lines[i])); i++; }
    out.push(`<div>${para.join("<br>")}</div>`);
  }
  return out.join("").replace(new RegExp(NUL + "(\\d+)" + NUL, "g"), (_, k) => codes[+k]);
}
