import type { Config } from "../config.js";
import { type Db, setConfigValue } from "../db.js";
import { score } from "../engine/scoring.js";
import type { LoadedModels } from "../models.js";
import { addDays, DAY } from "../util.js";

interface ShadowCase {
  kind: string;
  y: number;
  w: number;
  pChampion: number;
  pChallenger: number;
}

function logLoss(cases: ShadowCase[], pick: (c: ShadowCase) => number): number {
  const w = cases.reduce((s, c) => s + c.w, 0);
  return -cases.reduce((s, c) => {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, pick(c)));
    return s + c.w * (c.y * Math.log(p) + (1 - c.y) * Math.log(1 - p));
  }, 0) / w;
}

/** Weighted share confirmed among the top-k cases when ranked by one model's probability. */
function precisionAtK(cases: ShadowCase[], pick: (c: ShadowCase) => number, k: number): number {
  const top = [...cases].sort((a, b) => pick(b) - pick(a)).slice(0, Math.max(1, k));
  return top.reduce((s, c) => s + c.y, 0) / top.length;
}

/**
 * A refit model never goes straight live. It scores in shadow beside the
 * champion, and after the shadow period it is judged only on cases labelled
 * during that period, which it never trained on. It is promoted when its log
 * loss is lower and its precision at the alert budget is no worse; otherwise
 * it is retired and the next nightly refit tries again.
 */
export async function decideChallenger(db: Db, now: number, models: LoadedModels, cfg: Config) {
  const ch = models.challenger;
  if (!ch || models.challengerCreated === null) return { action: "none" as const };
  const o = cfg.engine.outcomes;
  if (now - models.challengerCreated < o.shadow_days * DAY) return { action: "shadow" as const, version: ch.version };
  const r = await db.query(
    `SELECT kind, verdict, weight, champion, scores FROM decisions
     WHERE verdict IS NOT NULL AND ts > $1 AND ts <= $2 AND scores ? $3`,
    [new Date(models.challengerCreated), new Date(now), ch.version],
  );
  const cases: ShadowCase[] = r.rows
    .filter((x) => x.scores[x.champion])
    .map((x) => ({ kind: x.kind, y: x.verdict === "confirmed" ? 1 : 0, w: x.weight, pChampion: x.scores[x.champion].p, pChallenger: x.scores[ch.version].p }));
  if (cases.length < o.shadow_min_cases) return { action: "shadow" as const, version: ch.version, cases: cases.length };
  const k = cases.filter((c) => c.kind === "alert").length;
  const cmp = {
    cases: cases.length,
    log_loss_champion: logLoss(cases, (c) => c.pChampion),
    log_loss_challenger: logLoss(cases, (c) => c.pChallenger),
    precision_at_budget_champion: precisionAtK(cases, (c) => c.pChampion, k),
    precision_at_budget_challenger: precisionAtK(cases, (c) => c.pChallenger, k),
  };
  const promote = cmp.log_loss_challenger < cmp.log_loss_champion && cmp.precision_at_budget_challenger >= cmp.precision_at_budget_champion;
  const at = new Date(now);
  if (promote) {
    await db.query("UPDATE models SET status = 'retired', decided_at = $1 WHERE kind = 'score' AND status = 'champion'", [at]);
    await db.query("UPDATE models SET status = 'champion', decided_at = $1, metrics = metrics || $2 WHERE version = $3", [at, JSON.stringify({ shadow: cmp }), ch.version]);
  } else {
    await db.query("UPDATE models SET status = 'retired', decided_at = $1, metrics = metrics || $2 WHERE version = $3", [at, JSON.stringify({ shadow: cmp }), ch.version]);
  }
  return { action: promote ? ("promoted" as const) : ("retired" as const), version: ch.version, ...cmp };
}

/**
 * The daily budget: tomorrow's threshold is the probability that would have
 * produced `daily_budget` alerts a day over the last seven days under the
 * current champion, never below the floor, so a quiet week doesn't lower the
 * bar to noise.
 */
export async function updateThreshold(db: Db, day: string, models: LoadedModels, cfg: Config): Promise<{ value: number; k: number; candidates: number }> {
  const a = cfg.engine.alerts;
  const from = addDays(day, -(a.threshold_window_days - 1));
  const r = await db.query(
    `SELECT ds.day, ds.x FROM daily_scores ds
     WHERE ds.day BETWEEN $1 AND $2
       -- accounts already in case management can't use any of tomorrow's budget
       AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.account_id = ds.account_id AND d.verdict = 'confirmed')`,
    [from, day],
  );
  const days = new Set(r.rows.map((x) => x.day)).size || 1;
  const ps = r.rows.map((x) => score(models.champion, x.x, cfg.engine.scoring.interval_z).p).sort((x, y) => y - x);
  const k = a.daily_budget * days;
  const value = Math.max(a.threshold_floor, ps.length >= k ? ps[k - 1] : a.threshold_floor);
  await setConfigValue(db, "threshold", { value, day, k, candidates: ps.length }, new Date());
  return { value, k, candidates: ps.length };
}
