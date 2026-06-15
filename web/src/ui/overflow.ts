// Graceful control overflow: when a header ROW can't fit all its controls, fold the trailing ones into a
// standardized "⋯" menu instead of clipping them. Reusable (panel headers, dense toolbars). ResizeObserver-driven.
//
//   row    = the element that constrains width (and clips on overflow), e.g. the panel header `.ph`.
//   bucket = the controls container inside row whose children get folded, e.g. `.sp`. Folding preserves the
//            actual DOM nodes (and their handlers) — controls keep working inside the menu.
export function installOverflow(row: HTMLElement, bucket: HTMLElement): void {
  const controls = [...bucket.children] as HTMLElement[];   // original controls, in order
  if (!controls.length) return;
  const more = document.createElement("button");
  more.className = "ovf-more mini"; more.textContent = "⋯"; more.title = "more controls"; more.style.display = "none";
  bucket.appendChild(more);
  const menu = document.createElement("div"); menu.className = "ovf-menu"; menu.style.display = "none"; row.appendChild(menu);   // child of row → removed with it (no leak); position:fixed escapes the panel's overflow clip

  const close = () => { menu.style.display = "none"; more.classList.remove("on"); };
  const onDoc = (e: MouseEvent) => { if (menu.style.display !== "none" && !menu.contains(e.target as Node) && e.target !== more) close(); };
  document.addEventListener("click", onDoc);
  more.onclick = (e) => {
    e.stopPropagation();
    if (menu.style.display !== "none") { close(); return; }
    menu.style.display = ""; more.classList.add("on");
    const r = more.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 6)) + "px";
    menu.style.top = (r.bottom + 4) + "px";
  };
  menu.addEventListener("click", () => close());   // acting on a folded control closes the menu

  let raf = 0;
  const relayout = () => {
    raf = 0; close();
    for (const c of controls) if (c.parentElement !== bucket) bucket.insertBefore(c, more);   // un-fold everything
    menu.textContent = ""; more.style.display = "none";
    if (row.scrollWidth <= row.clientWidth + 1) return;   // fits → no menu
    more.style.display = "";   // reserve its width, then fold from the end until it fits
    let i = controls.length - 1, guard = controls.length + 2;
    while (row.scrollWidth > row.clientWidth + 1 && i >= 0 && guard-- > 0) { menu.insertBefore(controls[i], menu.firstChild); i--; }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(relayout); };
  new ResizeObserver(schedule).observe(row);
  schedule();
}
