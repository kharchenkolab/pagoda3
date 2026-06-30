// Phase 4 UI: open a local L* store with no server — a full-page drop target + file/folder pickers.
// Hands the caller a File (a .zip), a FileSystemDirectoryHandle (Chromium drag/pick a folder), or a
// FileList (<input webkitdirectory>); data/localstore.ts turns any of them into a store. Nothing is
// uploaded — the bytes are read in the browser.

// Only react to EXTERNAL file drags, never the app's own panel/widget drag-and-drop.
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes("Files");
}

async function fromDrop(dt: DataTransfer): Promise<any> {
  const items = dt.items;
  if (items && items.length) {
    const it = items[0];
    const getHandle = (it as any).getAsFileSystemHandle;
    if (typeof getHandle === "function") {                 // Chromium: a real folder/file handle
      try {
        const h = await getHandle.call(it);
        if (h?.kind === "directory") return h;
        if (h?.kind === "file") return await h.getFile();
      } catch { /* fall through to getAsFile */ }
    }
    const f = it.getAsFile?.();
    if (f) return f;
  }
  return dt.files?.[0] || null;
}

/** Install the document-level drop target. `open` receives a File / handle / FileList. */
export function installOpenLocal(open: (input: any) => Promise<void>): void {
  const ov = document.createElement("div");
  ov.id = "dropov";
  ov.innerHTML =
    '<div class="dropbox"><div class="dropic">⤓</div>' +
    '<div class="droptt">Drop a dataset to open</div>' +
    '<div class="dropsub">a <code>.h5ad</code> or <code>.lstar.zarr.zip</code> file, or a <code>.lstar.zarr</code> folder — nothing is uploaded</div></div>';
  document.body.appendChild(ov);

  let depth = 0;   // dragenter/leave fire on descendants too — count to know when we truly left
  addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; ov.classList.add("show"); });
  addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; ov.classList.remove("show"); } });
  addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; ov.classList.remove("show");
    const input = await fromDrop(e.dataTransfer!);
    if (input) { try { await open(input); } catch (err) { alert((err as Error)?.message || "Couldn't open that dataset."); } }
  });
}

/** Pick a single data file — a ``*.h5ad`` (AnnData) or a ``*.lstar.zarr.zip``. */
export function pickFile(open: (f: File) => any): void {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".h5ad,.zip";
  inp.onchange = () => { const f = inp.files?.[0]; if (f) open(f); };
  inp.click();
}

/** Pick a ``*.lstar.zarr`` folder — the File System Access picker on Chromium, else webkitdirectory. */
export async function pickFolder(open: (input: any) => any): Promise<void> {
  if ((window as any).showDirectoryPicker) {
    try { return open(await (window as any).showDirectoryPicker()); } catch { return; }   // user cancelled
  }
  const inp = document.createElement("input");
  inp.type = "file";
  (inp as any).webkitdirectory = true;
  inp.onchange = () => { if (inp.files?.length) open(inp.files); };
  inp.click();
}
