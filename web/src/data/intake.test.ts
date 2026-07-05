// intake: storeToSpec must handle a DENSE counts measure (a bare store whose `counts` is dense, not CSC/CSR).
// Regression for the shared-reader adoption: the read now goes through the lstar reader's fieldAsCsc (dense/csr/csc
// → gene-major CSC), where it previously threw "`counts` is dense; need CSC or CSR". Per lstar's testing lesson,
// the fixture spans the ENCODING axis (a dense measure) that the all-CSC demo stores never exercise.
// Run: node --test src/data/intake.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeFSStore } from "../../../../lstar/js/core/node-store.ts";
import { writeStore } from "../../../../lstar/js/core/writer.ts";
import { openLstar } from "../../../../lstar/js/core/reader.ts";
import { storeToSpec } from "./intake.ts";

test("storeToSpec densifies a DENSE counts measure to CSC (was a crash)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "p3-intake-dense-"));
  const dir = path.join(base, "s.lstar.zarr");
  await writeStore(new NodeFSStore(dir), {
    kind: "sample", profiles: ["test@0.1"],
    axes: { cells: { labels: ["c0", "c1", "c2", "c3"], role: "observation" }, genes: { labels: ["g0", "g1", "g2"], role: "feature" } },
    fields: {
      // DENSE 4x3 (row-major cells x genes); 6 nonzeros
      counts: { role: "measure", span: ["cells", "genes"], encoding: "dense", state: "raw", shape: [4, 3],
                data: new Float32Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]) },
      leiden: { role: "label", span: ["cells"], encoding: "utf8", values: ["a", "a", "b", "b"] },
    },
  });
  const ds = await openLstar(new NodeFSStore(dir));
  const spec: any = await storeToSpec(ds);   // must NOT throw (old code rejected a dense measure)
  const c = spec.fields.counts;
  assert.equal(c.encoding, "csc", "dense counts came back as gene-major CSC");
  assert.deepEqual(c.shape, [4, 3]);
  assert.equal(c.data.length, 6, "the 6 nonzeros are preserved (zeros dropped)");
  // CSC is gene-major: indptr per gene (3 cols + 1); each gene here has 2 expressing cells
  assert.deepEqual([...c.indptr], [0, 2, 4, 6]);
  assert.ok(spec.fields.leiden, "the per-cell label is carried onto the cells axis");
  fs.rmSync(base, { recursive: true, force: true });
});
