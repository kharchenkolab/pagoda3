import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, "public");

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
  plugins: [zarrStorePlugin(), agentProxyPlugin()],
  server: { port: 8787, fs: { allow: ["..", "../..", "../../lstar"] }, proxy: { "/api": "http://localhost:8786" } },
  build: { target: "es2022" },
});
