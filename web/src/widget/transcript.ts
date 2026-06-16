// Test instrument: read an agent transcript (Anthropic message[] — what wagent.messages / app.liveMessages hold) the
// SAME structured way every time, and AUTO-FLAG deficiencies, friction, and errors. The agent's chat is the richest
// signal — its narration self-reports friction ("the probe ran before the draw completed", "renderedText only shows
// controls"), and its tool results carry the hard errors. Pure → unit-tested; used by the harness scenario runner.

export interface PreviewStep { ok: boolean | null; error: string | null; viz: string | null; probe: boolean; probeErrors: string[]; }
export interface TranscriptReport {
  durationMs: number;
  agentSays: string[];                 // the agent's narration turns (where it self-reports friction)
  toolCalls: { tool: string; key?: string }[];
  previews: PreviewStep[];
  metrics: { toolCalls: number; previews: number; previewFails: number; probeErrors: number; recipeLookups: number; recipesPulled: string[]; toolErrors: number; saved: boolean; finalSrcLen: number };
  frictions: string[];                 // the headline: everything worth looking at, ranked roughly by severity
}

// Sentences in agent narration that betray friction with the substrate (not the task).
const FRICTION_RE = /(before .{0,30}(complete|ready|load|draw|settle))|(only shows?)|(\brace\b)|work[- ]?around|fall[- ]?back|head ?less|isn'?t (text|extract|captured)|not a function|\bundefined\b|\bNaN\b|\b0 ?(circle|point|cell|width|height|×|x ?0)|client(Width|Height).{0,8}0|can'?t (see|tell|read|measure)|no way to/i;
const sentences = (t: string) => t.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);

function summarizeInput(name: string, input: any): string | undefined {
  if (!input) return undefined;
  if (input.query) return input.query;
  if (input.name) return input.name;
  if (input.source != null) return "src " + String(input.source).length + "b" + (input.probe ? " +probe" : "");
  if (input.kind) return input.kind;
  return undefined;
}

export function analyzeTranscript(messages: any[], durationMs = 0): TranscriptReport {
  const agentSays: string[] = [], toolCalls: { tool: string; key?: string }[] = [], previews: PreviewStep[] = [], frictions: string[] = [];
  const recipesPulled: string[] = [];
  let recipeLookups = 0, toolErrors = 0, saved = false, finalSrcLen = 0, pendingProbe = false;

  for (const m of messages) {
    const content = Array.isArray(m.content) ? m.content : (typeof m.content === "string" ? [{ type: "text", text: m.content, _user: m.role === "user" }] : []);
    for (const b of content) {
      if (b.type === "text" && b.text && !b._user) {
        const t = String(b.text).trim(); if (!t) continue;
        agentSays.push(t.length > 240 ? t.slice(0, 240) + "…" : t);
        for (const s of sentences(t)) if (FRICTION_RE.test(s)) frictions.push("agent noted: “" + (s.length > 160 ? s.slice(0, 160) + "…" : s) + "”");
      } else if (b.type === "tool_use") {
        toolCalls.push({ tool: b.name, key: summarizeInput(b.name, b.input) });
        if (b.name === "find_widget_recipe") recipeLookups++;
        else if (b.name === "get_widget_recipe") recipesPulled.push(b.input?.name || "?");
        else if (b.name === "save_widget") { saved = true; finalSrcLen = String(b.input?.source || "").length; }
        else if (b.name === "preview_widget") pendingProbe = !!b.input?.probe;
      } else if (b.type === "tool_result") {
        const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        if (parsed && ("ok" in parsed)) {   // a preview_widget result
          const logs: string[] = (parsed.logs || []).map((l: any) => (l.args || []).join(" "));
          const probeErrors = logs.filter((l) => /probe error:/i.test(l));
          const viz = (parsed.renderedText || "").match(/\[viz:[^\]]*\]/);
          previews.push({ ok: parsed.ok, error: parsed.error || null, viz: viz ? viz[0] : null, probe: pendingProbe, probeErrors });
          pendingProbe = false;
        } else if (/^error:|unknown (tool|data)|no recipe|REJECTED/i.test(raw)) { toolErrors++; frictions.push("tool error: " + raw.slice(0, 120)); }
      }
    }
  }

  const previewFails = previews.filter((p) => p.ok === false).length;
  const probeErrors = previews.reduce((s, p) => s + p.probeErrors.length, 0);
  // headline frictions (prepend the high-severity ones so they read first)
  const head: string[] = [];
  if (previewFails) head.push(`${previewFails} preview(s) failed: ${previews.filter((p) => p.ok === false).map((p) => p.error).join(" | ")}`);
  if (probeErrors) head.push(`${probeErrors} probe error(s): ${previews.flatMap((p) => p.probeErrors).slice(0, 3).join(" | ")}`);
  if (previews.length >= 3) head.push(`${previews.length} preview iterations — possible feedback/iteration friction`);
  if (!saved && messages.length) head.push("did not reach save_widget (incomplete or gave up)");

  return {
    durationMs,
    agentSays, toolCalls, previews,
    metrics: { toolCalls: toolCalls.length, previews: previews.length, previewFails, probeErrors, recipeLookups, recipesPulled, toolErrors, saved, finalSrcLen },
    frictions: head.concat(frictions),
  };
}
