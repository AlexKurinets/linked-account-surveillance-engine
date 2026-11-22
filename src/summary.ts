import type { Config } from "./config.js";
import { type Db, getConfigValue } from "./db.js";
import { ablation, evaluatePublished, loadTruth } from "./linking/evaluate.js";
import { loadEvidence } from "./linking/linker.js";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`);

/** Markdown tables of what the replay produced, straight from the database (used for the README). */
export async function summary(db: Db, cfg: Config): Promise<string> {
  const out: string[] = [];
  // only the replayed history; live days are still in progress
  const last = (await getConfigValue<{ last_day: string }>(db, "replay_progress"))?.last_day ?? "9999-12-31";
  const days = (await db.query("SELECT * FROM scorecard_daily WHERE day <= $1 ORDER BY day", [last])).rows;
  out.push("| Day | Champion | Threshold | Alerts | Precision | Recall estimate (90% interval) |", "|---|---|---|---|---|---|");
  for (const d of days) {
    out.push(`| ${d.day} | ${d.champion} | ${d.threshold.toFixed(2)} | ${d.alerts} | ${d.resolved ? pct(d.precision) : "n/a"}${d.resolved < d.alerts ? ` (${d.resolved} resolved)` : ""} | ${pct(d.recall_est)} (${pct(d.recall_lo)} to ${pct(d.recall_hi)}) |`);
  }
  const period = async (where: string) =>
    (await db.query(`SELECT count(*) AS alerts, count(verdict) AS resolved, count(*) FILTER (WHERE verdict = 'confirmed') AS confirmed
                     FROM decisions WHERE kind = 'alert' AND day <= $1 AND ${where}`, [last])).rows[0];
  const a = await period("champion = 'analyst-v1'");
  const l = await period("champion <> 'analyst-v1'");
  out.push("", "| Scored by | Alerts | Confirmed | Precision |", "|---|---|---|---|");
  out.push(`| the analysts' starting weights | ${a.alerts} | ${a.confirmed} | ${pct(a.confirmed / Math.max(1, a.resolved))} |`);
  out.push(`| refitted models, after shadow promotion | ${l.alerts} | ${l.confirmed} | ${pct(l.confirmed / Math.max(1, l.resolved))} |`);

  const roles = (await db.query(
    `SELECT t.role, count(DISTINCT t.account_id) AS accounts,
            count(DISTINCT d.account_id) FILTER (WHERE d.kind = 'alert' AND d.verdict = 'confirmed') AS caught,
            count(DISTINCT d.account_id) FILTER (WHERE d.reasons->>'lane' = 'anomaly' AND d.verdict = 'confirmed') AS via_lane
     FROM sim_truth t LEFT JOIN decisions d USING (account_id) WHERE t.role IN ('ring','mule','spoofer') GROUP BY 1 ORDER BY 1`,
  )).rows;
  out.push("", "| Bad actors (synthetic truth) | Accounts | Confirmed through an alert | Of those, through the anomaly lane |", "|---|---|---|---|");
  for (const r of roles) out.push(`| ${r.role} | ${r.accounts} | ${r.caught} | ${r.via_lane} |`);

  const truth = await loadTruth(db);
  const pub = await evaluatePublished(db, truth);
  const ab = ablation(await loadEvidence(db, new Date(8.64e15)), cfg.engine.linking, truth);
  out.push("", "| Linking variant | Pair precision | Pair recall | Clusters | Largest | Household pairs linked | Market-maker pairs linked |", "|---|---|---|---|---|---|---|");
  for (const r of ab) out.push(`| ${r.variant} | ${pct(r.precision)} | ${pct(r.recall)} | ${r.clusters} | ${r.largest_cluster} | ${r.household_pairs_linked} | ${r.market_maker_pairs_linked} |`);
  out.push("", `published clusters: ${JSON.stringify(pub)}`);

  const shadow = (await db.query("SELECT status, count(*) AS n FROM models WHERE kind = 'score' AND version <> 'analyst-v1' GROUP BY 1")).rows;
  const reports = (await db.query("SELECT source, count(*) AS n, sum(attempts) AS drafts FROM reports GROUP BY 1")).rows;
  const fresh = (await db.query(
    "SELECT count(*) AS batches, sum(events) AS events, percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_p95_ms) AS p95 FROM engine_metrics WHERE mode = 'live'",
  )).rows[0];
  out.push(`refits: ${JSON.stringify(shadow)}; reports: ${JSON.stringify(reports)}; live: ${JSON.stringify(fresh)}`);
  return out.join("\n");
}
