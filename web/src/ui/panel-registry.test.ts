// Unit tests for the pure panel-type registry. Run: `node --test src/ui/panel-registry.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { registerPanelType, getPanelType, isPanelType, panelTypes, agentPanelTypes, isAgentPanelType } from "./panel-registry.ts";

test("register + lookup; agent subset is filtered; unknown → undefined/false", () => {
  const bodyA = () => ({ el: null });
  const bodyB = () => ({ el: null });
  registerPanelType({ type: "MockAgentPanel", body: bodyA, agent: true });
  registerPanelType({ type: "MockAppPanel", body: bodyB });   // not agent-addable

  assert.equal(getPanelType("MockAgentPanel")?.body, bodyA);
  assert.equal(isPanelType("MockAppPanel"), true);
  assert.equal(isPanelType("Nope"), false);
  assert.equal(getPanelType("Nope"), undefined);

  assert.ok(panelTypes().includes("MockAgentPanel") && panelTypes().includes("MockAppPanel"));   // both renderable
  assert.ok(agentPanelTypes().includes("MockAgentPanel"));    // agent subset
  assert.ok(!agentPanelTypes().includes("MockAppPanel"));     // app-only excluded
  assert.equal(isAgentPanelType("MockAgentPanel"), true);
  assert.equal(isAgentPanelType("MockAppPanel"), false);
  assert.equal(isAgentPanelType("Nope"), false);
});

test("re-registering a type replaces its def (last wins — an external module can override)", () => {
  const v1 = () => ({ el: 1 }), v2 = () => ({ el: 2 });
  registerPanelType({ type: "MockReplace", body: v1, agent: true });
  registerPanelType({ type: "MockReplace", body: v2 });
  assert.equal(getPanelType("MockReplace")?.body, v2);
  assert.equal(isAgentPanelType("MockReplace"), false);   // the override dropped agent
});
