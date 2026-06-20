// Unit tests for the widget runtime's pure permission helper. Run: `node --test src/widget/runtime.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { hostMatches } from "./runtime.ts";

test("hostMatches: exact host + subdomains, but not look-alikes", () => {
  const allow = ["rcsb.org", "uniprot.org"];
  assert.equal(hostMatches("https://rcsb.org/x", allow), true);          // exact
  assert.equal(hostMatches("https://files.rcsb.org/download/1abc.pdb", allow), true);   // subdomain
  assert.equal(hostMatches("https://rest.uniprot.org/uniprotkb/P0.json", allow), true); // other declared host
  assert.equal(hostMatches("https://evil-rcsb.org/x", allow), false);    // prefix look-alike
  assert.equal(hostMatches("https://rcsb.org.evil.com/x", allow), false);// suffix look-alike (the dangerous one)
  assert.equal(hostMatches("https://ncbi.nlm.nih.gov/x", allow), false); // undeclared host
});

test("hostMatches: case-insensitive host; unparseable URL never allowed", () => {
  assert.equal(hostMatches("https://FILES.RCSB.ORG/x", ["rcsb.org"]), true);   // host lower-cased
  assert.equal(hostMatches("not a url", ["rcsb.org"]), false);
  assert.equal(hostMatches("https://rcsb.org", []), false);   // empty allow → nothing matches
});
