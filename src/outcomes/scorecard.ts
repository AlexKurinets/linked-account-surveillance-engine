import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { LoadedModels } from "../models.js";
import { addDays, quantile, Rng } from "../util.js";

interface Labelled {
  kind: "alert" | "audit";
  p: number;
  y: number;
  w: number;
  x: Record<string, number>;
}

export interface Band {
  lo: number;
  hi: number;
  cases: number;
  stated: number;
  confirmed_rate: number;
}

/**
 * Recall from the audit: confirmed alerts are bad accounts the engine found;
 * confirmed audit cases, each standing for 1 / pi accounts, are bad accounts it
 * missed. recall = found / (found + missed). The interval is a bootstrap over
 * both sets, and it is always reported with the point estimate.
 */
export function recallEstimate(rows: Labelled[], seed: number): { est: number | null; lo: number | null; hi: number | null } {
  const alerts = rows.filter((r) => r.kind === "alert");
  const audits = rows.filter((r) => r.kind === "audit");
  const calc = (al: Labelled[], au: Labelled[]) => {
    const found = al.reduce((s, r) => s + r.y, 0);
    const missed = au.reduce((s, r) => s + r.y * r.w, 0);
    return found + missed > 0 ? found / (found + missed) : null;
  };
  const est = calc(alerts, audits);
  if (est === null) return { est: null, lo: null, hi: null };
  const rng = new Rng(seed);
  const sims: number[] = [];
  for (let b = 0; b < 400; b++) {
    const al = alerts.map(() => alerts[Math.floor(rng.next() * alerts.length)]);
    const au = audits.map(() => audits[Math.floor(rng.next() * audits.length)]);
    const v = calc(al, au);
    if (v !== null) sims.push(v);
  }
  sims.sort((a, b) => a - b);
  return { est, lo: quantile(sims, 0.05), hi: quantile(sims, 0.95) };
}

export function calibrationBands(rows: Labelled[]): Band[] {
  const bands: Band[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const inBand = rows.filter((r) => r.p >= lo && (r.p < hi || (i === 9 && r.p <= 1)));
    if (!inBand.length) continue;
    const w = inBand.reduce((s, r) => s + r.w, 0);
    bands.push({
      lo,
      hi,
      cases: inBand.length,
      stated: inBand.reduce((s, r) => s + r.w * r.p, 0) / w,
      confirmed_rate: inBand.reduce((s, r) => s + r.w * r.y, 0) / w,
    });
  }
  return bands;
}

export async function computeScorecard(db: Db, day: string, models: LoadedModels, threshold: number, cfg: Config) {
  const W = cfg.engine.outcomes.recall_window_days;
  const from = addDays(day, -(W - 1));
  const today = await db.query(
    `SELECT count(*) AS alerts, count(verdict) AS resolved, count(*) FILTER (WHERE verdict = 'confirmed') AS confirmed
     FROM decisions WHERE kind = 'alert' AND day = $1`,
    [day],
  );
  const t = today.rows[0];
  const lab = await db.query(
    `SELECT kind, p, verdict, weight, x FROM decisions WHERE verdict IS NOT NULL AND day BETWEEN $1 AND $2`,
    [from, day],
  );
  const rows: Labelled[] = lab.rows.map((r) => ({ kind: r.kind, p: r.p, y: r.verdict === "confirmed" ? 1 : 0, w: r.weight, x: r.x }));
  const recall = recallEstimate(rows, Number(day.replaceAll("-", "")));
  const wsum = rows.reduce((s, r) => s + r.w, 0);
  const brier = wsum > 0 ? rows.reduce((s, r) => s + r.w * (r.p - r.y) ** 2, 0) / wsum : null;
  const byRule: Record<string, { alerts: number; confirmed: number; precision: number | null }> = {};
  for (const rule of cfg.rules) {
    const fired = rows.filter((r) => r.kind === "alert" && r.x[`rule:${rule.id}`] === 1);
    const c = fired.reduce((s, r) => s + r.y, 0);
    byRule[rule.id] = { alerts: fired.length, confirmed: c, precision: fired.length ? c / fired.length : null };
  }
  const row = {
    day,
    champion: models.champion.version,
    challenger: models.challenger?.version ?? null,
    threshold,
    alerts: Number(t.alerts),
    resolved: Number(t.resolved),
    confirmed: Number(t.confirmed),
    precision: Number(t.resolved) ? Number(t.confirmed) / Number(t.resolved) : null,
    window_days: W,
    recall_est: recall.est,
    recall_lo: recall.lo,
    recall_hi: recall.hi,
    brier,
    bands: calibrationBands(rows),
    by_rule: byRule,
  };
  await db.query(
    `INSERT INTO scorecard_daily (day, champion, challenger, threshold, alerts, resolved, confirmed, precision, window_days,
       recall_est, recall_lo, recall_hi, brier, bands, by_rule)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (day) DO UPDATE SET champion = EXCLUDED.champion, challenger = EXCLUDED.challenger, threshold = EXCLUDED.threshold,
       alerts = EXCLUDED.alerts, resolved = EXCLUDED.resolved, confirmed = EXCLUDED.confirmed, precision = EXCLUDED.precision,
       window_days = EXCLUDED.window_days, recall_est = EXCLUDED.recall_est, recall_lo = EXCLUDED.recall_lo, recall_hi = EXCLUDED.recall_hi,
       brier = EXCLUDED.brier, bands = EXCLUDED.bands, by_rule = EXCLUDED.by_rule`,
    [row.day, row.champion, row.challenger, row.threshold, row.alerts, row.resolved, row.confirmed, row.precision, row.window_days,
      row.recall_est, row.recall_lo, row.recall_hi, row.brier, JSON.stringify(row.bands), JSON.stringify(row.by_rule)],
  );
  return row;
}

/** Re-score every resolved alert of a day once more verdicts have landed (precision firms up over 20 hours). */
export async function refreshPrecision(db: Db, day: string): Promise<void> {
  await db.query(
    `UPDATE scorecard_daily s SET resolved = d.resolved, confirmed = d.confirmed,
       precision = CASE WHEN d.resolved > 0 THEN d.confirmed::float8 / d.resolved END
     FROM (SELECT count(verdict) AS resolved, count(*) FILTER (WHERE verdict = 'confirmed') AS confirmed
           FROM decisions WHERE kind = 'alert' AND day = $1) d
     WHERE s.day = $1`,
    [day],
  );
}
