import { test } from "node:test";
import assert from "node:assert/strict";
import { newLoopState, isStuck } from "./loopguard.ts";

test("loop guard bails on the 3rd identical call", () => {
  const st = newLoopState();
  assert.equal(isStuck("A", st), false);   // 1st
  assert.equal(isStuck("B", st), false);   // new sig → reset
  assert.equal(isStuck("B", st), false);   // 2nd identical
  assert.equal(isStuck("B", st), true);    // 3rd identical → stuck
});

test("varied calls never trip the guard (no false positives on real multi-step flows)", () => {
  const st = newLoopState();
  for (const s of ["compute:de", "update_view:add", "preview_widget:x", "edit_widget:1", "edit_widget:2", "save_widget:y"]) {
    assert.equal(isStuck(s, st), false);
  }
});

test("alternating A/B does not stick; a fresh run of 3 identical does", () => {
  const st = newLoopState();
  for (const s of ["A", "B", "A", "B", "A"]) assert.equal(isStuck(s, st), false);   // never 3 in a row
  assert.equal(isStuck("A", st), false);   // ...A,A
  assert.equal(isStuck("A", st), true);    // A,A,A → stuck
});

test("productive repeats never trip (a stateful action like 'trigger N times'); only no-progress spins do", () => {
  const st = newLoopState();
  for (let i = 0; i < 5; i++) assert.equal(isStuck("trigger:inc", st, true), false);   // byte-identical but each APPLIED → fine
  // the same call now stops making progress (bounces) → it should trip after the limit
  assert.equal(isStuck("trigger:inc", st, false), false);   // 1st no-progress
  assert.equal(isStuck("trigger:inc", st, false), true);    // 2nd no-progress in a row → stuck
});

test("empty signature is ignored (no false stick on a no-tool turn)", () => {
  const st = newLoopState();
  assert.equal(isStuck("", st), false);
  assert.equal(isStuck("", st), false);
  assert.equal(isStuck("", st), false);
});
