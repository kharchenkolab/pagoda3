// parseDeepLinkAsk: extract the ?ask=<directive> generative deep-link param. Run: node --test src/ui/sharelink.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeepLinkAsk } from "./sharelink.ts";

test("parseDeepLinkAsk extracts + percent-decodes the ?ask directive, else null", () => {
  assert.equal(parseDeepLinkAsk("?ask=color%20by%20cell%20cycle"), "color by cell cycle");        // decoded
  assert.equal(parseDeepLinkAsk("?store=/x.lstar.zarr/&ask=compare%20day0%20vs%20day7"), "compare day0 vs day7");  // among other params
  assert.equal(parseDeepLinkAsk("ask=hi"), "hi");                          // bare query (no leading ?)
  assert.equal(parseDeepLinkAsk("?ask=%20%20trim%20me%20%20"), "trim me"); // trimmed
  assert.equal(parseDeepLinkAsk("?ask=a%26b%3Dc"), "a&b=c");               // encoded &,= survive decode
  // absent / empty / whitespace-only → null (no auto-run)
  assert.equal(parseDeepLinkAsk("?store=/x.lstar.zarr/"), null);
  assert.equal(parseDeepLinkAsk("?ask="), null);
  assert.equal(parseDeepLinkAsk("?ask=%20%20"), null);
  assert.equal(parseDeepLinkAsk(""), null);
});
