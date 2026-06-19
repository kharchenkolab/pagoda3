import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicAdapter, openaiAdapter, canonicalToOpenAIMessages, stripThink, providerModel } from "./providers.ts";

// A small canonical (Anthropic-shaped) conversation: user → assistant(text+tool_use) → tool_result.
const CONVO = [
  { role: "user", content: "color the embedding by CD3D" },
  { role: "assistant", content: [{ type: "text", text: "Recoloring." }, { type: "tool_use", id: "t1", name: "update_view", input: { color: "gene:CD3D" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "applied: colour gene:CD3D" }] },
];
const TOOLS = [{ name: "update_view", description: "change what is shown", input_schema: { type: "object", properties: { color: { type: "string" } } } }];

test("anthropic buildBody: pass-through (system string, messages, tools, model, max_tokens)", () => {
  const b = anthropicAdapter.buildBody({ system: "SYS", messages: CONVO, tools: TOOLS, maxTokens: 8192 });
  assert.equal(b.system, "SYS");
  assert.equal(b.model, providerModel("anthropic"));
  assert.equal(b.max_tokens, 8192);
  assert.equal(b.messages, CONVO);          // same ref — no translation
  assert.equal(b.tools, TOOLS);
  assert.equal(b.tool_choice, undefined);   // proxy adds nothing extra here
});

test("anthropic parseEvent: content_block_* + message_delta → the canonical op stream", () => {
  const st = anthropicAdapter.newState();
  const ops = [
    ...anthropicAdapter.parseEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }, st),
    ...anthropicAdapter.parseEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, st),
    ...anthropicAdapter.parseEvent({ type: "content_block_stop" }, st),
    ...anthropicAdapter.parseEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "update_view" } }, st),
    ...anthropicAdapter.parseEvent({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"color\":" } }, st),
    ...anthropicAdapter.parseEvent({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "\"gene:CD3D\"}" } }, st),
    ...anthropicAdapter.parseEvent({ type: "content_block_stop" }, st),
    ...anthropicAdapter.parseEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }, st),
  ];
  assert.deepEqual(ops, [
    { op: "textStart" }, { op: "text", text: "hi" }, { op: "blockStop" },
    { op: "toolStart", id: "t1", name: "update_view" }, { op: "toolArgs", json: "{\"color\":" }, { op: "toolArgs", json: "\"gene:CD3D\"}" }, { op: "blockStop" },
    { op: "stop", reason: "tool_use" },
  ]);
});

test("openai buildBody: canonical history → OpenAI shape", () => {
  const b = openaiAdapter.buildBody({ system: "SYS", messages: CONVO, tools: TOOLS, maxTokens: 4096 });
  assert.equal(b.model, providerModel("openai"));
  assert.equal(b.stream, true);
  assert.deepEqual(b.stream_options, { include_usage: true });
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  // system extracted to messages[0]; tool_use → tool_calls; tool_result → role:tool
  assert.deepEqual(b.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "color the embedding by CD3D" },
    { role: "assistant", content: "Recoloring.", tool_calls: [{ id: "t1", type: "function", function: { name: "update_view", arguments: "{\"color\":\"gene:CD3D\"}" } }] },
    { role: "tool", tool_call_id: "t1", content: "applied: colour gene:CD3D" },
  ]);
  // input_schema → function.parameters
  assert.deepEqual(b.tools, [{ type: "function", function: { name: "update_view", description: "change what is shown", parameters: TOOLS[0].input_schema } }]);
  assert.equal(b.tool_choice, "auto");
});

test("openai buildBody: assistant with no text → content null", () => {
  const b = openaiAdapter.buildBody({ system: "", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "compute", input: {} }] }], tools: [], maxTokens: 10 });
  assert.equal(b.messages[0].content, null);
  assert.equal(b.messages[0].tool_calls[0].id, "x");
  assert.equal(b.tools, undefined);   // no tools → no tool_choice/tools
});

test("openai parseEvent: streamed tool call across fragments → ops + reassembled args", () => {
  const st = openaiAdapter.newState();
  const feed = (o: any) => openaiAdapter.parseEvent(o, st);
  const ops = [
    ...feed({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
    ...feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "update_view", arguments: "" } }] } }] }),
    ...feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"color\":" } }] } }] }),
    ...feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"MS4A1\"}" } }] } }] }),
    ...feed({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ...feed({ choices: [], usage: { prompt_tokens: 161, completion_tokens: 23 } }),
  ];
  assert.deepEqual(ops, [
    { op: "toolStart", id: "call_a", name: "update_view" },
    { op: "toolArgs", json: "{\"color\":" },
    { op: "toolArgs", json: "\"MS4A1\"}" },
    { op: "blockStop" },
    { op: "stop", reason: "tool_use" },
    { op: "usage", usage: { prompt_tokens: 161, completion_tokens: 23 } },
  ]);
  const args = ops.filter((o: any) => o.op === "toolArgs").map((o: any) => o.json).join("");
  assert.deepEqual(JSON.parse(args), { color: "MS4A1" });
});

test("openai parseEvent: plain text answer → textStart/text then stop(end_turn)", () => {
  const st = openaiAdapter.newState();
  const ops = [
    ...openaiAdapter.parseEvent({ choices: [{ index: 0, delta: { content: "Done" } }] }, st),
    ...openaiAdapter.parseEvent({ choices: [{ index: 0, delta: { content: " — recolored." } }] }, st),
    ...openaiAdapter.parseEvent({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, st),
  ];
  assert.deepEqual(ops, [
    { op: "textStart" }, { op: "text", text: "Done" }, { op: "text", text: " — recolored." }, { op: "blockStop" }, { op: "stop", reason: "end_turn" },
  ]);
});

test("stripThink: removes <think>…</think> across fragments, keeps visible text", () => {
  const st: any = { inThink: false };
  assert.equal(stripThink("<think>reasoning ", st), "");
  assert.equal(st.inThink, true);
  assert.equal(stripThink("more reasoning</think>visible", st), "visible");
  assert.equal(st.inThink, false);
  assert.equal(stripThink("plain", st), "plain");
  assert.equal(stripThink("a<think>b</think>c", st), "ac");   // whole pair in one fragment
});

test("canonicalToOpenAIMessages: each message kind", () => {
  assert.deepEqual(canonicalToOpenAIMessages({ role: "user", content: "hi" }), [{ role: "user", content: "hi" }]);
  assert.deepEqual(
    canonicalToOpenAIMessages({ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r1" }, { type: "tool_result", tool_use_id: "b", content: "r2" }] }),
    [{ role: "tool", tool_call_id: "a", content: "r1" }, { role: "tool", tool_call_id: "b", content: "r2" }],
  );
});
