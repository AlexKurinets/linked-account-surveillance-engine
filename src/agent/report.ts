import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import { type Db, withTx } from "../db.js";
import { candidateClusters, composeReport } from "./compose.js";
import type { ReportModel } from "./model.js";
import { executeTool, getCluster, getModelChanges, getOpenItems, getScorecard, listAlerts, type MemoryUpdate, TOOLS, ToolContext } from "./tools.js";
import { checkReport, type Report } from "./validate.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

const SYSTEM = `You write the morning surveillance report for a compliance team at a derivatives venue.
You run unattended. Use the tools to read the day's scorecard, alerts, model changes and your open items.
Look up every cluster that has alerts or is already an open item before deciding what to say about it.
Every open item from earlier runs must either stay in decisions_needed or be closed with a reason, and
you must stage the same choices with update_open_items before you answer.
Quote numbers exactly as the tools return them. Do not add, subtract or average numbers yourself; if a
total you want is not in a tool result, leave it out.
Answer with one JSON object and nothing else:
{"day": "YYYY-MM-DD", "summary": "...", "decisions_needed": [{"subject_type": "cluster|link_review|rule",
"subject_id": "...", "why": "...", "recommended_action": "..."}], "closed_items": [{"subject_type": "...",
"subject_id": "...", "reason": "..."}], "changes": ["..."]}`;

const MAX_TURNS = 12;
const MAX_DRAFTS = 2;

export interface ReportOutcome {
  day: string;
  source: "agent" | "template";
  attempts: number;
  errors: string[][];
  report: Report;
  toolCalls: number;
}

export function renderMarkdown(r: Report, source: string): string {
  const lines = [`# Surveillance report, ${r.day}`, "", r.summary, ""];
  lines.push("## Decisions needed", "");
  if (!r.decisions_needed.length) lines.push("None.", "");
  for (const d of r.decisions_needed) lines.push(`- **${d.subject_type} ${d.subject_id}**: ${d.why} ${d.recommended_action}`);
  if (r.decisions_needed.length) lines.push("");
  if (r.closed_items.length) {
    lines.push("## Closed since the last report", "");
    for (const c of r.closed_items) lines.push(`- ${c.subject_type} ${c.subject_id}: ${c.reason}`);
    lines.push("");
  }
  if (r.changes.length) {
    lines.push("## Changes", "");
    for (const c of r.changes) lines.push(`- ${c}`);
    lines.push("");
  }
  lines.push(`_Written by: ${source}._`);
  return lines.join("\n");
}

/** Built from the same tool results without any model, when the agent's drafts fail their checks twice. */
async function templateReport(ctx: ToolContext): Promise<{ report: Report; updates: MemoryUpdate[] }> {
  const openItems = await getOpenItems(ctx.db);
  const alerts = await listAlerts(ctx, ctx.day);
  const clusters: Record<string, any> = {};
  for (const id of candidateClusters(openItems, alerts)) clusters[id] = await getCluster(ctx, id);
  return composeReport({
    day: ctx.day,
    openItems,
    scorecard: await getScorecard(ctx, ctx.day),
    alerts,
    changes: await getModelChanges(ctx, ctx.day),
    clusters,
  });
}

async function publish(db: Db, out: ReportOutcome, updates: MemoryUpdate[], modelName: string): Promise<void> {
  await withTx(db, async (tx) => {
    for (const u of updates) {
      if (u.action === "close") {
        await tx.query(
          "UPDATE open_items SET status = 'closed', last_day = $3, closed_reason = $4 WHERE subject_type = $1 AND subject_id = $2",
          [u.subject_type, u.subject_id, out.day, u.reason ?? u.note],
        );
      } else {
        await tx.query(
          `INSERT INTO open_items (subject_type, subject_id, status, opened_day, last_day, note) VALUES ($1, $2, 'open', $3, $3, $4)
           ON CONFLICT (subject_type, subject_id) DO UPDATE SET status = 'open', last_day = EXCLUDED.last_day, note = EXCLUDED.note, closed_reason = NULL`,
          [u.subject_type, u.subject_id, out.day, u.note],
        );
      }
    }
    const source = out.source === "agent" ? `agent (${modelName})` : "template fallback after failed checks";
    await tx.query(
      `INSERT INTO reports (day, source, attempts, report, markdown, check_errors, tool_calls, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (day) DO UPDATE SET source = EXCLUDED.source, attempts = EXCLUDED.attempts, report = EXCLUDED.report,
         markdown = EXCLUDED.markdown, check_errors = EXCLUDED.check_errors, tool_calls = EXCLUDED.tool_calls, created_at = now()`,
      [out.day, out.source, out.attempts, JSON.stringify(out.report), renderMarkdown(out.report, source), JSON.stringify(out.errors), out.toolCalls],
    );
    if (out.source === "template") {
      await tx.query("INSERT INTO pages (ts, source, message) VALUES (now(), 'report-agent', $1)", [
        `Report for ${out.day} fell back to the template after ${out.attempts} failed draft(s): ${out.errors.flat().slice(0, 3).join("; ")}`,
      ]);
    }
  });
}

/**
 * The unattended morning run. Tool loop, then the checks. A failed draft goes
 * back to the model once with the errors listed; a second failure publishes the
 * template report and pages the operator, so the analysts always get a report
 * and never get an unchecked one.
 */
export async function runReport(db: Db, day: string, model: ReportModel, cfg: Config): Promise<ReportOutcome> {
  const ctx = new ToolContext(db, day, cfg);
  const openAtStart = await getOpenItems(db);
  const messages: MessageParam[] = [{ role: "user", content: `Write the morning report for ${day}.` }];
  const errors: string[][] = [];
  let drafts = 0;

  for (let turn = 0; turn < MAX_TURNS && drafts < MAX_DRAFTS; turn++) {
    let res;
    try {
      res = await model.next({ system: SYSTEM, tools: TOOLS, messages });
    } catch (err) {
      errors.push([`model call failed: ${(err as Error).message}`]);
      break;
    }
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue;
    if (res.stop_reason === "tool_use") {
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        try {
          const out = await executeTool(ctx, block.name, block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: `tool failed: ${(err as Error).message}`, is_error: true });
        }
      }
      // all results go back in one user message, so parallel tool use keeps working
      messages.push({ role: "user", content: results });
      continue;
    }
    if (res.stop_reason !== "end_turn") {
      errors.push([`model stopped with ${res.stop_reason}`]);
      break;
    }
    drafts++;
    const raw = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const check = await checkReport(raw, { db, cfg, day, results: ctx.results, openAtStart, staged: ctx.staged });
    if (check.ok) {
      const out: ReportOutcome = { day, source: "agent", attempts: drafts, errors, report: check.report, toolCalls: ctx.calls };
      await publish(db, out, ctx.staged, model.name);
      return out;
    }
    errors.push(check.errors);
    if (drafts < MAX_DRAFTS) {
      messages.push({ role: "user", content: `Your report failed these checks. Fix them and answer with the corrected JSON only:\n- ${check.errors.join("\n- ")}` });
    }
  }

  const fallback = await templateReport(new ToolContext(db, day, cfg));
  const out: ReportOutcome = { day, source: "template", attempts: drafts, errors, report: fallback.report, toolCalls: ctx.calls };
  await publish(db, out, fallback.updates, model.name);
  return out;
}
