import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { MemoryUpdate, OpenItem } from "./tools.js";

/** What the agent must return. */
export const ReportSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  summary: z.string().min(20).max(1200),
  decisions_needed: z.array(
    z.object({
      subject_type: z.enum(["cluster", "link_review", "rule"]),
      subject_id: z.string(),
      why: z.string().min(5),
      recommended_action: z.string().min(5),
    }),
  ),
  closed_items: z.array(z.object({ subject_type: z.enum(["cluster", "link_review", "rule"]), subject_id: z.string(), reason: z.string().min(5) })),
  changes: z.array(z.string()),
});
export type Report = z.infer<typeof ReportSchema>;

const ID_PATTERNS = [/\bAL-\d+\b/g, /\b[AC]\d{5}\b/g, /\b(?:score|anomaly)-\d{8}T\d{4}\b/g, /\banalyst-v\d+\b/g, /\b\d{4}-\d{2}-\d{2}\b/g];
// Unsigned on purpose: "40-60%" is two numbers, not 40 and -60.
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;

function texts(r: Report): string[] {
  return [
    r.summary,
    ...r.decisions_needed.flatMap((d) => [d.why, d.recommended_action]),
    ...r.closed_items.map((c) => c.reason),
    ...r.changes,
  ];
}

/** Every number anywhere in the tool results, in the forms a writer might reasonably quote it. */
export function groundedNumbers(results: unknown[]): Set<string> {
  const out = new Set<string>();
  const add = (v: number) => {
    out.add(String(v));
    for (let d = 0; d <= 3; d++) out.add(String(Number(v.toFixed(d))));
  };
  const walk = (x: unknown) => {
    if (typeof x === "number" && Number.isFinite(x)) add(Math.abs(x));
    else if (typeof x === "string") {
      let s = x;
      for (const re of ID_PATTERNS) s = s.replace(re, " ");
      for (const m of s.match(NUMBER) ?? []) add(Number(m.replaceAll(",", "")));
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  results.forEach(walk);
  return out;
}

export function ungroundedNumbers(r: Report, grounded: Set<string>): string[] {
  const bad: string[] = [];
  for (const t of texts(r)) {
    let s = t;
    for (const re of ID_PATTERNS) s = s.replace(re, " ");
    for (const m of s.match(NUMBER) ?? []) {
      const v = Number(m.replaceAll(",", ""));
      if (!grounded.has(String(v))) bad.push(m);
    }
  }
  return [...new Set(bad)];
}

async function exists(db: Db, cfg: Config, type: string, id: string): Promise<boolean> {
  if (type === "rule") return cfg.rules.some((r) => r.id === id);
  if (type === "link_review") {
    const [a, b] = id.split("|");
    return (await db.query("SELECT 1 FROM link_reviews WHERE a = $1 AND b = $2", [a, b])).rows.length > 0;
  }
  if (type === "cluster") {
    const q = await db.query(
      `SELECT 1 FROM clusters WHERE cluster_id = $1
       UNION SELECT 1 FROM open_items WHERE subject_type = 'cluster' AND subject_id = $1
       UNION SELECT 1 FROM decisions WHERE cluster_id = $1 LIMIT 1`,
      [id],
    );
    return q.rows.length > 0;
  }
  return false;
}

/**
 * The checks every draft must pass before anyone reads it. Plain code, not
 * another model:
 *  1. it matches the schema and is for the right day
 *  2. every number in the text appears in a tool result from this run
 *  3. every account, cluster and alert ID it cites exists
 *  4. every item open at the start of the run is carried or closed with a reason
 *  5. the memory updates it staged agree with what the report says
 */
export async function checkReport(
  raw: string,
  ctx: { db: Db; cfg: Config; day: string; results: unknown[]; openAtStart: OpenItem[]; staged: MemoryUpdate[] },
): Promise<{ ok: true; report: Report } | { ok: false; errors: string[] }> {
  let json: unknown;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, errors: ["output is not valid JSON"] };
  }
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `schema: ${i.path.join(".")}: ${i.message}`) };
  const r = parsed.data;
  const errors: string[] = [];
  if (r.day !== ctx.day) errors.push(`report is for ${r.day}, expected ${ctx.day}`);

  const bad = ungroundedNumbers(r, groundedNumbers(ctx.results));
  if (bad.length) errors.push(`numbers not found in any tool result from this run: ${bad.join(", ")}`);

  const all = texts(r).join(" ");
  const accounts = [...new Set(all.match(/\bA\d{5}\b/g) ?? [])];
  if (accounts.length) {
    const q = await ctx.db.query("SELECT account_id FROM accounts WHERE account_id = ANY($1)", [accounts]);
    const known = new Set(q.rows.map((x) => x.account_id));
    for (const a of accounts) if (!known.has(a)) errors.push(`unknown account ${a}`);
  }
  for (const c of new Set(all.match(/\bC\d{5}\b/g) ?? [])) if (!(await exists(ctx.db, ctx.cfg, "cluster", c))) errors.push(`unknown cluster ${c}`);
  const alertIds = [...new Set((all.match(/\bAL-\d+\b/g) ?? []).map((x) => Number(x.slice(3))))];
  if (alertIds.length) {
    const q = await ctx.db.query("SELECT id FROM decisions WHERE id = ANY($1) AND kind = 'alert'", [alertIds]);
    const known = new Set(q.rows.map((x) => Number(x.id)));
    for (const id of alertIds) if (!known.has(id)) errors.push(`unknown alert AL-${id}`);
  }
  for (const d of [...r.decisions_needed, ...r.closed_items]) {
    if (!(await exists(ctx.db, ctx.cfg, d.subject_type, d.subject_id))) errors.push(`unknown ${d.subject_type} ${d.subject_id}`);
  }

  const key = (t: string, id: string) => `${t}:${id}`;
  const carried = new Set(r.decisions_needed.map((d) => key(d.subject_type, d.subject_id)));
  const closed = new Set(r.closed_items.map((c) => key(c.subject_type, c.subject_id)));
  for (const o of ctx.openAtStart) {
    const k = key(o.subject_type, o.subject_id);
    if (!carried.has(k) && !closed.has(k)) errors.push(`open item ${k} was neither carried nor closed`);
  }
  const openKeys = new Set(ctx.openAtStart.map((o) => key(o.subject_type, o.subject_id)));
  for (const c of r.closed_items) if (!openKeys.has(key(c.subject_type, c.subject_id))) errors.push(`closed ${key(c.subject_type, c.subject_id)}, which was not open`);

  const staged = new Map(ctx.staged.map((u) => [key(u.subject_type, u.subject_id), u.action]));
  for (const k of carried) if (!["open", "carry"].includes(staged.get(k) ?? "")) errors.push(`memory: ${k} is in decisions_needed but was not staged as open or carry`);
  for (const k of closed) if (staged.get(k) !== "close") errors.push(`memory: ${k} is closed in the report but was not staged as close`);

  return errors.length ? { ok: false, errors } : { ok: true, report: r };
}
