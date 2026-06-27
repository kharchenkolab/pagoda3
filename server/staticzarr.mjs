// Throwaway static file server for zarr perf testing (Phase 1). Range + CORS + configurable cache headers + request
// logging. NOT part of the app — a controllable stand-in for "static HTTP serving zarr" so we can vary the HTTP layer
// (range, cache-control, CORS preflight caching) and measure. Run: node server/staticzarr.mjs [root] [port].
//   env: ZARR_CACHE=immutable|none (default immutable for chunk files), ZARR_DELAY=ms (simulate latency per request).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || "web/public");
const PORT = Number(process.argv[3] || 9100);
const CACHE = process.env.ZARR_CACHE || "immutable";
const DELAY = Number(process.env.ZARR_DELAY || 0);
let nReq = 0, nBytes = 0;

const server = http.createServer((req, res) => {
  // CORS — allow any origin, and the bits a cross-origin RANGE read needs (preflight + exposed range headers)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, Content-Encoding");
  res.setHeader("Access-Control-Max-Age", "86400");   // cache the preflight a day → no per-request OPTIONS tax
  res.setHeader("Timing-Allow-Origin", "*");           // let the Resource Timing API report real sizes cross-origin
  res.setHeader("Accept-Ranges", "bytes");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.statusCode = 403; return res.end("forbidden"); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; return res.end("not found"); }
    // cache: zarr chunk files are content-addressed-ish + immutable per dataset version; metadata (.z*) revalidate
    const isMeta = /\.(zarray|zgroup|zattrs)$/.test(urlPath) || urlPath.endsWith("zarr.json");
    res.setHeader("Cache-Control", CACHE === "none" || isMeta ? "no-cache" : "public, max-age=31536000, immutable");
    res.setHeader("Content-Type", "application/octet-stream");

    const range = req.headers["range"];
    const send = () => {
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = Number(m[1]); const end = m[2] ? Number(m[2]) : st.size - 1;
          if (start >= st.size || end >= st.size || start > end) { res.statusCode = 416; res.setHeader("Content-Range", `bytes */${st.size}`); return res.end(); }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
          res.setHeader("Content-Length", end - start + 1);
          nReq++; nBytes += end - start + 1;
          if (req.method === "HEAD") return res.end();
          return fs.createReadStream(filePath, { start, end }).pipe(res);
        }
      }
      res.statusCode = 200;
      res.setHeader("Content-Length", st.size);
      nReq++; nBytes += st.size;
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(filePath).pipe(res);
    };
    DELAY ? setTimeout(send, DELAY) : send();
  });
});

server.listen(PORT, () => console.log(`[staticzarr] root=${ROOT} port=${PORT} cache=${CACHE} delay=${DELAY}ms — range+CORS on`));
setInterval(() => { if (nReq) { console.log(`[staticzarr] served ${nReq} reqs, ${(nBytes / 1e6).toFixed(1)} MB`); nReq = 0; nBytes = 0; } }, 5000).unref?.();
