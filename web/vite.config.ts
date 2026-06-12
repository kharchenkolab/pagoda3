import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, "public");

// Copy the built lstar WASM kernels (lstar/js/dist) into public/wasm so the app loads the
// real libstar kernels at /wasm/lstar_kernels.mjs. Skipped if the dist isn't built (emsdk
// absent) — the app then falls back to its pure-TS kernels.
function wasmCopyPlugin() {
  const dest = path.resolve(PUBLIC, "wasm");
  return {
    name: "copy-lstar-wasm",
    configureServer(server: any) {
      const dist = path.resolve(__dirname, "../../lstar/js/dist");
      try {
        if (fs.existsSync(dist)) { fs.mkdirSync(dest, { recursive: true }); for (const f of fs.readdirSync(dist)) fs.copyFileSync(path.join(dist, f), path.join(dest, f)); }
      } catch (e) { console.warn("[wasm] copy skipped:", e); }
      // Serve /wasm/* explicitly with correct MIME (Vite's SPA fallback otherwise shadows it).
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = (req.url || "").split("?")[0];
        if (!url.startsWith("/wasm/")) return next();
        const file = path.join(dest, url.slice("/wasm/".length));
        if (!file.startsWith(dest) || !fs.existsSync(file)) { res.statusCode = 404; return res.end("not found"); }
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "application/javascript");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

// Spawn the agent proxy alongside the dev server (it exits quietly if already running).
function agentProxyPlugin() {
  return {
    name: "agent-proxy",
    configureServer(server: any) {
      const child = spawn("node", [path.resolve(__dirname, "../server/proxy.mjs")], { stdio: "inherit" });
      const kill = () => { try { child.kill(); } catch {} };
      server.httpServer?.once("close", kill);
      process.once("exit", kill);
    },
  };
}

// Serve .lstar.zarr stores (incl. dotfiles .zgroup/.zattrs/.zmetadata, which Vite's
// static server otherwise hides) directly from public/, returning 404 for missing keys
// so zarrita falls through v3->v2 cleanly. Mirrors the production store host.
function zarrStorePlugin() {
  return {
    name: "lstar-zarr-store",
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = (req.url || "").split("?")[0];
        if (!url.includes(".lstar.zarr/")) return next();
        const rel = decodeURIComponent(url.replace(/^\/+/, ""));
        const file = path.join(PUBLIC, rel);
        if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end("forbidden"); }
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Access-Control-Allow-Origin", "*");
          return fs.createReadStream(file).pipe(res);
        }
        res.statusCode = 404;
        res.end("not found");
      });
    },
  };
}

export default defineConfig({
  plugins: [zarrStorePlugin(), wasmCopyPlugin(), agentProxyPlugin()],
  server: { port: 8787, fs: { allow: ["..", "../..", "../../lstar"] }, proxy: { "/api": "http://localhost:8786" } },
  build: { target: "es2022" },
});
