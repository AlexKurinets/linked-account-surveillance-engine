import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { addDays } from "../util.js";

/**
 * The report agent's six tools: five read-only and one that stages updates to
 * its memory (the open-items table). Staged updates are committed only when a
 * report that passed its checks, or the template fallback, is published.
 *
 * Tools return totals and percentages already computed. In production the
 * model's own arithmetic was the main source of failed number checks.
 */
export type Tool = Anthropic.Beta.Messages.BetaTool;

const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 1000) / 10);

export interface OpenItem {
  subject_type: "cluster" | "link_review" | "rule";
  subject_id: string;
  opened_day: string;
  last_day: string;
  note: string;
}

export interface MemoryUpdate {
  subject_type: OpenItem["subject_type"];
  subject_id: string;
  action: "open" | "carry" | "close";
  note: string;
  reason?: string;
}

export class ToolContext {
  readonly results: unknown[] = [];
  readonly staged: MemoryUpdate[] = [];
  calls = 0;
  constructor(readonly db: Db, readonly day: string, readonly cfg: Config) {}
}

const SubjectType = z.enum(["cluster", "link_review", "rule"]);
const UpdateInput = z.object({
  updates: z.array(
    z.object({
      subject_type: SubjectType,
      subject_id: z.string(),
      action: z.enum(["open", "carry", "close"]),
      note: z.string(),
      reason: z.string().optional(),
    }),
  ),
});

const strict = (name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool => ({
  name,
  description,
  strict: true,
  input_schema: { type: "object", properties, required, additionalProperties: false },
});

export const TOOLS: Tool[] = [
  strict("get_scorecard", "Scorecard for one day and the day before: alerts, verdicts, precision, estimated recall with its interval, calibration bands and per-rule precision. Percentages are already computed.", { day: { type: "string", description: "YYYY-MM-DD" } }, ["day"]),
  strict("list_alerts", "Alerts raised on one day with probability, interval, top reasons and verdict status, plus totals by status.", { day: { type: "string", description: "YYYY-MM-DD" } }, ["day"]),
  strict("get_cluster", "One linked cluster: members, the evidence behind each link, alerts on its members and any analyst action.", { cluster_id: { type: "string" } }, ["cluster_id"]),
  strict("get_model_changes", "Scoring model promotions and retirements, the alert threshold, rules with low precision, merges waiting for an analyst, and the alerting policy constants.", { day: { type: "string", description: "YYYY-MM-DD" } }, ["day"]),
  strict("get_open_items", "Open items carried from earlier reports (your memory between runs).", {}, []),
  strict(
    "update_open_items",
    "Stage changes to the open items: open a new item, carry an existing one, or close one with a reason. Committed when the report is published.",
    {
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subject_type: { type: "string", enum: ["cluster", "link_review", "rule"] },
            subject_id: { type: "string" },
            action: { type: "string", enum: ["open", "carry", "close"] },
            note: { type: "string" },
            reason: { type: "string" },
          },
          required: ["subject_type", "subject_id", "action", "note"],
          additionalProperties: false,
        },
      },
    },
    ["updates"],
  ),
];

async function scorecardRow(db: Db, day: string) {
  const r = await db.query("SELECT * FROM scorecard_daily WHERE day = $1", [day]);
  if (!r.rows.length) return null;
  const s = r.rows[0];
  return {
    day: s.day,
    champion: s.champion,
    challenger: s.challenger,
    threshold: Math.round(s.threshold * 1000) / 1000,
    alerts: s.alerts,
    resolved: s.resolved,
    confirmed: s.confirmed,
    pending: s.alerts - s.resolved,
    precision_pct: pct(s.precision),
    recall_window_days: s.window_days,
    recall_est_pct: pct(s.recall_est),
    recall_interval_pct: [pct(s.recall_lo), pct(s.recall_hi)],
    brier: s.brier === null ? null : Math.round(s.brier * 1000) / 1000,
    calibration_bands: (s.bands as any[]).map((b) => ({ band: `${pct(b.lo)}-${pct(b.hi)}%`, cases: b.cases, stated_pct: pct(b.stated), confirmed_pct: pct(b.confirmed_rate) })),
    by_rule: Object.fromEntries(Object.entries(s.by_rule as Record<string, any>).map(([k, v]) => [k, { alerts: v.alerts, confirmed: v.confirmed, precision_pct: pct(v.precision) }])),
  };
}

export async function getScorecard(ctx: ToolContext, day: string) {
  return { today: await scorecardRow(ctx.db, day), previous_day: await scorecardRow(ctx.db, addDays(day, -1)) };
}

export async function listAlerts(ctx: ToolContext, day: string) {
  const r = await ctx.db.query(
    "SELECT id, account_id, cluster_id, p, reasons, verdict FROM decisions WHERE kind = 'alert' AND day = $1 ORDER BY p DESC",
    [day],
  );
  const rows = r.rows;
  return {
    day,
    totals: {
      alerts: rows.length,
      confirmed: rows.filter((x) => x.verdict === "confirmed").length,
      rejected: rows.filter((x) => x.verdict === "rejected").length,
      pending: rows.filter((x) => !x.verdict).length,
      in_clusters: rows.filter((x) => x.cluster_id).length,
    },
    alerts: rows.slice(0, 60).map((x) => ({
      alert_id: `AL-${x.id}`,
      account_id: x.account_id,
      cluster_id: x.cluster_id,
      p_pct: pct(x.p),
      interval_pct: (x.reasons.interval_80 ?? []).map((v: number) => pct(v)),
      rules: (x.reasons.rules ?? []).map((q: any) => q.rule),
      unusual: (x.reasons.anomaly?.unusual ?? []).map((u: any) => u.feature),
      verdict: x.verdict ?? "pending",
    })),
  };
}

export async function getCluster(ctx: ToolContext, clusterId: string) {
  const c = await ctx.db.query("SELECT cluster_id, members, min_link_score, first_seen FROM clusters WHERE cluster_id = $1", [clusterId]);
  if (!c.rows.length) return { error: `no cluster ${clusterId}` };
  const members: string[] = c.rows[0].members;
  const links = await ctx.db.query("SELECT a, b, score, families, evidence FROM links WHERE a = ANY($1) ORDER BY score DESC", [members]);
  const alerts = await ctx.db.query(
    "SELECT id, account_id, day, verdict FROM decisions WHERE kind = 'alert' AND account_id = ANY($1) AND day <= $2 ORDER BY id",
    [members, ctx.day],
  );
  const action = await ctx.db.query("SELECT day, action, note FROM cluster_actions WHERE cluster_id = $1 AND day <= $2", [clusterId, ctx.day]);
  return {
    cluster_id: clusterId,
    size: members.length,
    members,
    first_seen_day: new Date(c.rows[0].first_seen).toISOString().slice(0, 10),
    links: links.rows.map((l) => ({ a: l.a, b: l.b, score: Math.round(l.score * 100) / 100, families: l.families, evidence: l.evidence })),
    alerts: alerts.rows.map((a) => ({ alert_id: `AL-${a.id}`, account_id: a.account_id, day: a.day, verdict: a.verdict ?? "pending" })),
    confirmed_alerts: alerts.rows.filter((a) => a.verdict === "confirmed").length,
    analyst_action: action.rows[0] ? { day: action.rows[0].day, action: action.rows[0].action, note: action.rows[0].note } : null,
  };
}

export async function getModelChanges(ctx: ToolContext, day: string) {
  const m = await ctx.db.query(
    `SELECT version, status, metrics, created_at, decided_at FROM models
     WHERE kind = 'score' AND (decided_at::date = $1 OR created_at::date = $1 OR status IN ('champion','challenger'))
     ORDER BY created_at`,
    [day],
  );
  const th = await ctx.db.query("SELECT threshold FROM scorecard_daily WHERE day IN ($1, $2) ORDER BY day", [addDays(day, -1), day]);
  const sc = await scorecardRow(ctx.db, day);
  const lowRules = Object.entries(sc?.by_rule ?? {})
    .filter(([, v]) => v.alerts >= 5 && v.precision_pct !== null && v.precision_pct < 25)
    .map(([rule, v]) => ({ rule, ...v }));
  const reviews = await ctx.db.query("SELECT a, b, score, reason FROM link_reviews WHERE created_at::date <= $1 ORDER BY score DESC LIMIT 10", [day]);
  const a = ctx.cfg.engine.alerts;
  return {
    models: m.rows.map((r) => ({
      version: r.version,
      status: r.status,
      created_day: new Date(r.created_at).toISOString().slice(0, 10),
      decided_day: r.decided_at ? new Date(r.decided_at).toISOString().slice(0, 10) : null,
      shadow:
        r.metrics.shadow &&
        {
          cases: r.metrics.shadow.cases,
          log_loss_champion: Math.round(r.metrics.shadow.log_loss_champion * 1000) / 1000,
          log_loss_challenger: Math.round(r.metrics.shadow.log_loss_challenger * 1000) / 1000,
          precision_at_budget_champion_pct: pct(r.metrics.shadow.precision_at_budget_champion),
          precision_at_budget_challenger_pct: pct(r.metrics.shadow.precision_at_budget_challenger),
        },
    })),
    threshold: { previous: th.rows.length > 1 ? Math.round(th.rows[0].threshold * 1000) / 1000 : null, today: sc?.threshold ?? null },
    rules_below_25pct_precision: lowRules,
    merges_waiting_for_review: reviews.rows.map((r) => ({ review_id: `${r.a}|${r.b}`, score: Math.round(r.score * 100) / 100, reason: r.reason })),
    policy: {
      daily_budget: a.daily_budget,
      cluster_cooldown_hours: a.cluster_cooldown_hours,
      rejected_suppression_days: a.rejected_suppression_days,
      shadow_days: ctx.cfg.engine.outcomes.shadow_days,
      recall_window_days: ctx.cfg.engine.outcomes.recall_window_days,
      interval_pct: 80,
      max_cluster_size: ctx.cfg.engine.linking.max_cluster_size,
    },
  };
}

export async function getOpenItems(db: Db): Promise<OpenItem[]> {
  const r = await db.query("SELECT subject_type, subject_id, opened_day, last_day, note FROM open_items WHERE status = 'open' ORDER BY opened_day, subject_id");
  return r.rows;
}

export async function executeTool(ctx: ToolContext, name: string, input: unknown): Promise<unknown> {
  ctx.calls++;
  const args = (input ?? {}) as Record<string, unknown>;
  const day = typeof args.day === "string" ? args.day : ctx.day;
  if (day > ctx.day) return { error: `cannot read ${day}, which is after the report day ${ctx.day}` };
  let out: unknown;
  switch (name) {
    case "get_scorecard":
      out = await getScorecard(ctx, day);
      break;
    case "list_alerts":
      out = await listAlerts(ctx, day);
      break;
    case "get_cluster":
      out = await getCluster(ctx, String(args.cluster_id));
      break;
    case "get_model_changes":
      out = await getModelChanges(ctx, day);
      break;
    case "get_open_items": {
      const items = await getOpenItems(ctx.db);
      out = { count: items.length, open_items: items };
      break;
    }
    case "update_open_items": {
      const parsed = UpdateInput.safeParse(args);
      if (!parsed.success) return { error: parsed.error.message };
      ctx.staged.push(...parsed.data.updates);
      out = { staged: parsed.data.updates.length, total_staged: ctx.staged.length };
      break;
    }
    default:
      return { error: `unknown tool ${name}` };
  }
  ctx.results.push(out);
  return out;
}
