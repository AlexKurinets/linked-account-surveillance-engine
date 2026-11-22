import type { EngineConfig } from "../config.js";
import type { Db } from "../db.js";
import { DAY, HOUR } from "../util.js";

export type AlertCheck =
  | { alert: true }
  | { alert: false; why: "below_threshold" | "in_case" | "awaiting_verdict" | "recently_rejected" | "cluster_cooldown" };

/**
 * What the analysts already have in front of them, so the engine doesn't send
 * the same thing twice:
 *  - a confirmed account is in case management and never alerts again
 *  - an account with an alert awaiting a verdict waits for that verdict
 *  - a rejected account stays quiet for 7 days unless its probability rises by 0.15
 *  - a cluster gets one alert per 24 hours unless its probability rises by 0.15
 */
export class AlertBook {
  private confirmed = new Set<string>();
  private pending = new Set<string>();
  private rejected = new Map<string, { ts: number; p: number }>();
  private lastCluster = new Map<string, { ts: number; p: number }>();

  constructor(private cfg: EngineConfig["alerts"]) {}

  async load(db: Db): Promise<void> {
    this.confirmed.clear();
    this.pending.clear();
    this.rejected.clear();
    this.lastCluster.clear();
    const r = await db.query(
      `SELECT account_id, cluster_id, ts, p, verdict, verdict_at FROM decisions WHERE kind = 'alert' ORDER BY ts`,
    );
    for (const row of r.rows) {
      const ts = new Date(row.ts).getTime();
      this.record(row.account_id, row.cluster_id, row.p, ts);
      if (row.verdict) this.applyVerdict(row.account_id, row.verdict, row.p, new Date(row.verdict_at).getTime());
    }
    // Audit verdicts that confirmed an account also put it in case management.
    const a = await db.query(`SELECT DISTINCT account_id FROM decisions WHERE kind = 'audit' AND verdict = 'confirmed'`);
    for (const row of a.rows) this.confirmed.add(row.account_id);
  }

  check(account: string, cluster: string | null, p: number, now: number, threshold: number): AlertCheck {
    if (this.confirmed.has(account)) return { alert: false, why: "in_case" };
    if (this.pending.has(account)) return { alert: false, why: "awaiting_verdict" };
    if (p < threshold) return { alert: false, why: "below_threshold" };
    const rej = this.rejected.get(account);
    if (rej && now - rej.ts < this.cfg.rejected_suppression_days * DAY && p < rej.p + this.cfg.cooldown_override_rise) {
      return { alert: false, why: "recently_rejected" };
    }
    if (cluster) {
      const last = this.lastCluster.get(cluster);
      if (last && now - last.ts < this.cfg.cluster_cooldown_hours * HOUR && p < last.p + this.cfg.cooldown_override_rise) {
        return { alert: false, why: "cluster_cooldown" };
      }
    }
    return { alert: true };
  }

  record(account: string, cluster: string | null, p: number, ts: number): void {
    this.pending.add(account);
    if (cluster) this.lastCluster.set(cluster, { ts, p });
  }

  applyVerdict(account: string, verdict: "confirmed" | "rejected", p: number, ts: number): void {
    this.pending.delete(account);
    if (verdict === "confirmed") this.confirmed.add(account);
    else this.rejected.set(account, { ts, p });
  }

  isInCase(account: string): boolean {
    return this.confirmed.has(account);
  }
}
