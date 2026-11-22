import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { score } from "../engine/scoring.js";
import type { LoadedModels } from "../models.js";
import { addDays, DAY, dayStart, HOUR } from "../util.js";

/**
 * Stand-in for the two compliance analysts. In production these verdicts come
 * from the case queue; here they come from the synthetic ground truth, with a
 * little label noise and a realistic delay, so the scorecard and the refit see
 * the same shape of data they would see live.
 */
const BAD_ROLES = new Set(["ring", "mule", "spoofer"]);

/** Deterministic hash in [0, 1) so verdicts and samples repeat exactly across runs. */
export function unit(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_003) / 1_000_003;
}

async function roles(db: Db): Promise<Map<string, string>> {
  const r = await db.query("SELECT account_id, role FROM sim_truth");
  return new Map(r.rows.map((x) => [x.account_id, x.role]));
}

function verdictFor(role: string | undefined, noise: number, key: string): "confirmed" | "rejected" {
  const truth = BAD_ROLES.has(role ?? "");
  const flip = unit("noise", key) < noise;
  return truth !== flip ? "confirmed" : "rejected";
}

/** Verdicts land 2 to 20 hours after the alert. */
export async function applyVerdicts(db: Db, now: number, cfg: Config): Promise<number> {
  const role = await roles(db);
  const r = await db.query("SELECT id, account_id, ts FROM decisions WHERE kind = 'alert' AND verdict IS NULL AND ts <= $1", [new Date(now - 2 * HOUR)]);
  let n = 0;
  for (const row of r.rows) {
    const at = new Date(row.ts).getTime() + (2 + Math.floor(unit("delay", row.id) * 18)) * HOUR;
    if (at > now) continue;
    await db.query("UPDATE decisions SET verdict = $2, verdict_at = $3 WHERE id = $1", [
      row.id, verdictFor(role.get(row.account_id), cfg.engine.outcomes.verdict_noise, `alert-${row.id}`), new Date(at),
    ]);
    n++;
  }
  return n;
}

/**
 * The weekly audit of accounts that were not alerted. Every account gets one
 * audit slot a week (a fixed weekday from a hash of its id), so the load is
 * spread across days and no account can be sampled twice inside a 7-day
 * window. On its slot day an account that was active in the last 7 days, was
 * not alerted in that time and is not already in case management is sampled
 * with probability pi, ten times higher just under the threshold. Each sampled
 * case carries weight 1 / pi, which is what lets the scorecard estimate recall
 * and the refit learn from what the alerts never showed.
 */
export async function sampleAudit(db: Db, day: string, threshold: number, models: LoadedModels, cfg: Config): Promise<number> {
  const role = await roles(db);
  const o = cfg.engine.outcomes;
  const from = addDays(day, -6);
  const r = await db.query(
    `SELECT DISTINCT ON (ds.account_id) ds.account_id, ds.max_p, ds.x
     FROM daily_scores ds
     WHERE ds.day BETWEEN $1 AND $2
       AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.account_id = ds.account_id AND d.kind = 'alert' AND d.day BETWEEN $1 AND $2)
       AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.account_id = ds.account_id AND d.verdict = 'confirmed')
       AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.account_id = ds.account_id AND d.kind = 'audit' AND d.day BETWEEN $1 AND $2)
     ORDER BY ds.account_id, ds.max_p DESC`,
    [from, day],
  );
  const slot = Math.floor(dayStart(day) / DAY) % 7;
  const at = new Date(dayStart(addDays(day, 1)) - 1);
  const z = cfg.engine.scoring.interval_z;
  let n = 0;
  for (const row of r.rows) {
    if (Math.floor(unit("slot", row.account_id) * 7) !== slot) continue;
    const near = row.max_p >= threshold / 2 && row.max_p < threshold;
    const pi = near ? o.audit_near_threshold_rate : o.audit_base_rate;
    if (unit("audit", row.account_id, day) >= pi) continue;
    const champ = score(models.champion, row.x, z);
    const scores: Record<string, { p: number; lo: number; hi: number }> = { [champ.version]: { p: champ.p, lo: champ.lo, hi: champ.hi } };
    if (models.challenger) {
      const c = score(models.challenger, row.x, z);
      scores[c.version] = { p: c.p, lo: c.lo, hi: c.hi };
    }
    await db.query(
      `INSERT INTO decisions (ts, day, account_id, cluster_id, kind, x, scores, champion, p, threshold, weight, reasons, verdict, verdict_at)
       VALUES ($1, $2, $3, NULL, 'audit', $4, $5, $6, $7, $8, $9, $10, $11, $1)`,
      [at, day, row.account_id, JSON.stringify(row.x), JSON.stringify(scores), champ.version, champ.p, threshold, 1 / pi,
        JSON.stringify({ stratum: near ? "near_threshold" : "base", sampling_probability: pi }),
        verdictFor(role.get(row.account_id), o.audit_verdict_noise, `audit-${row.account_id}-${day}`)],
    );
    n++;
  }
  return n;
}

/**
 * Analysts decide what to do about a cluster one to two days after one of its
 * accounts is confirmed: restrict it when the accounts really are run by one
 * person, clear it otherwise.
 */
export async function decideClusters(db: Db, day: string): Promise<number> {
  const truth = await db.query("SELECT account_id, role, group_id FROM sim_truth WHERE role = 'ring'");
  const ring = new Map(truth.rows.map((x) => [x.account_id, x.group_id]));
  const r = await db.query(
    `SELECT c.cluster_id, c.members, min(d.verdict_at) AS first_confirmed
     FROM clusters c JOIN decisions d ON d.account_id = ANY(c.members) AND d.verdict = 'confirmed'
     WHERE NOT EXISTS (SELECT 1 FROM cluster_actions a WHERE a.cluster_id = c.cluster_id)
     GROUP BY c.cluster_id, c.members`,
  );
  let n = 0;
  for (const row of r.rows) {
    const wait = 1 + Math.floor(unit("decide", row.cluster_id) * 2);
    if (new Date(row.first_confirmed).getTime() + wait * DAY > dayStart(addDays(day, 1))) continue;
    const groups = new Set((row.members as string[]).map((m) => ring.get(m) ?? `x-${m}`));
    const sameOperator = groups.size === 1 && ring.has(row.members[0]);
    await db.query("INSERT INTO cluster_actions (cluster_id, day, action, note) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [
      row.cluster_id, day, sameOperator ? "restricted" : "cleared",
      sameOperator ? `withdrawals held on all ${row.members.length} accounts` : "accounts judged unrelated; link left in place for monitoring",
    ]);
    n++;
  }
  return n;
}
