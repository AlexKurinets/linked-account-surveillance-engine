import type { Config } from "../config.js";
import { type Db, getConfigValue, withTx } from "../db.js";
import { EvidenceTracker } from "../linking/evidence.js";
import { ensureChampion, type LoadedModels, loadModels } from "../models.js";
import { dayOf, quantile } from "../util.js";
import { AlertBook } from "./alerts.js";
import { anomalyRarity, anomalyReasons, anomalyScore, anomalyVector } from "./anomaly.js";
import { IndexPrices } from "./indexPrices.js";
import { score, type Score, scoreInputs } from "./scoring.js";
import { type AccountState, applyEvent, decayFactor, type EngineEvent, type Features, features, newState } from "./state.js";

export interface AccountScore {
  f: Features;
  x: Record<string, number>;
  champion: Score;
  challenger: Score | null;
  anomaly: { score: number; rarity: number; top: { feature: string; z: number }[] } | null;
}

interface DecisionRow {
  ts: number;
  account_id: string;
  cluster_id: string | null;
  x: Record<string, number>;
  scores: Record<string, { p: number; lo: number; hi: number }>;
  champion: string;
  p: number;
  threshold: number;
  reasons: Record<string, unknown>;
}

// Events that change nothing a rule or the forest looks at are not re-scored.
const SCORED = new Set(["order", "fill", "deposit", "withdrawal", "session_start"]);

/**
 * The stream consumer. Keeps every account's state in memory, scores it on each
 * event, decides alerts, and writes changed state, evidence, decisions and its
 * own cursor in one transaction per batch, so a crash replays at most one
 * uncommitted batch and nothing is counted twice. Its clock is event time, which
 * is why replaying history reproduces exactly the state living through it did.
 */
export class Engine {
  readonly states = new Map<string, AccountState>();
  readonly prices = new IndexPrices();
  readonly evidence: EvidenceTracker;
  readonly book: AlertBook;
  models!: LoadedModels;
  threshold = 0.5;
  cursor = { event: 0, price: 0, eventTime: 0 };

  private opened = new Map<string, number>();
  private marketMakers = new Set<string>();
  private clusterOfAcct = new Map<string, string>();
  private clusterMembers = new Map<string, string[]>();
  private linkEvidence = new Map<string, { score: number; evidence: Record<string, unknown> }>();
  private latest = new Map<string, AccountScore>();
  private dirty = new Set<string>();
  private dirtyClusters = new Set<string>();
  private decisions: DecisionRow[] = [];
  private laneCount = new Map<string, number>();
  private scoreCount = new Map<string, number>();
  /** alerts withheld per day because the day's budget was already used */
  readonly capped = new Map<string, number>();
  private dailyMax = new Map<string, { account: string; day: string; p: number; x: Record<string, number> }>();
  private clustersVersion = "";
  private modelsVersion = "";

  constructor(private db: Db, private cfg: Config, private consumer = "engine") {
    this.evidence = new EvidenceTracker(cfg.engine.linking);
    this.book = new AlertBook(cfg.engine.alerts);
  }

  async init(): Promise<void> {
    await ensureChampion(this.db, this.cfg, new Date());
    const acc = await this.db.query("SELECT account_id, opened_at, tier FROM accounts");
    for (const r of acc.rows) {
      this.opened.set(r.account_id, new Date(r.opened_at).getTime());
      if (r.tier === "market_maker") this.marketMakers.add(r.account_id);
    }
    const st = await this.db.query("SELECT account_id, state FROM account_state");
    for (const r of st.rows) this.states.set(r.account_id, r.state);
    const cur = await this.db.query("SELECT last_event_id, last_price_id, event_time FROM consumer_cursor WHERE consumer = $1", [this.consumer]);
    if (cur.rows.length) {
      const c = cur.rows[0];
      this.cursor = { event: Number(c.last_event_id), price: Number(c.last_price_id), eventTime: c.event_time ? new Date(c.event_time).getTime() : 0 };
      const px = await this.db.query(
        "SELECT ts, contract, price FROM index_prices WHERE id <= $1 AND ts >= $2 ORDER BY id",
        [this.cursor.price, new Date(this.cursor.eventTime - 6 * 3_600_000)],
      );
      for (const r of px.rows) this.prices.add(r.contract, new Date(r.ts).getTime(), r.price);
    }
    await this.evidence.load(this.db);
    if (this.cursor.event) await this.evidence.warm(this.db, this.cursor.event, this.cursor.eventTime);
    const lanes = await this.db.query("SELECT day, reasons->>'lane' AS lane, count(*) AS n FROM decisions WHERE kind = 'alert' GROUP BY 1, 2");
    for (const r of lanes.rows) (r.lane === "anomaly" ? this.laneCount : this.scoreCount).set(r.day, Number(r.n));
    await this.refresh(true);
  }

  /** Pick up new models, clusters, threshold and verdicts written by the jobs. Cheap when nothing changed. */
  async refresh(force = false): Promise<void> {
    const mv = await this.db.query("SELECT string_agg(version || status, ',' ORDER BY version) AS v FROM models WHERE status <> 'retired'");
    if (force || mv.rows[0].v !== this.modelsVersion) {
      this.models = await loadModels(this.db);
      this.modelsVersion = mv.rows[0].v;
    }
    const cv = JSON.stringify(await getConfigValue(this.db, "clusters_version"));
    if (force || cv !== this.clustersVersion) {
      await this.loadClusters();
      this.clustersVersion = cv;
    }
    const th = await getConfigValue<{ value: number }>(this.db, "threshold");
    this.threshold = th?.value ?? this.cfg.engine.alerts.initial_threshold;
    await this.book.load(this.db);
  }

  private async loadClusters(): Promise<void> {
    this.clusterOfAcct.clear();
    this.clusterMembers.clear();
    this.linkEvidence.clear();
    const c = await this.db.query("SELECT cluster_id, members FROM clusters");
    for (const r of c.rows) {
      this.clusterMembers.set(r.cluster_id, r.members);
      for (const m of r.members) this.clusterOfAcct.set(m, r.cluster_id);
    }
    const l = await this.db.query("SELECT a, b, score, evidence FROM links");
    for (const r of l.rows) this.linkEvidence.set(`${r.a}|${r.b}`, { score: r.score, evidence: r.evidence });
  }

  clusterOf = (a: string): string | null => this.clusterOfAcct.get(a) ?? null;

  /** Share of a cluster's fill notional traded between its own members, read at `now`. */
  clusterInternalShare(cid: string, now: number): number {
    let internal = 0;
    let total = 0;
    for (const m of this.clusterMembers.get(cid) ?? []) {
      const s = this.states.get(m);
      if (!s) continue;
      const fl = decayFactor(now - s.t, this.cfg.engine.state.long_half_life_minutes);
      internal += s.cluster_notional_l * fl;
      total += s.notional_l * fl;
    }
    return total > 1 ? Math.min(1, internal / total) : 0;
  }

  scoreAccount(acct: string, now: number): AccountScore {
    const s = this.states.get(acct)!;
    const f = features(s, now, this.cfg.engine.state);
    let anomaly: AccountScore["anomaly"] = null;
    if (this.models.anomaly) {
      const v = anomalyVector(this.models.anomaly, f);
      const s = anomalyScore(this.models.anomaly, v);
      anomaly = { score: s, rarity: anomalyRarity(this.models.anomaly, s), top: anomalyReasons(this.models.anomaly, v) };
    }
    const cid = this.clusterOf(acct);
    const x = scoreInputs(this.cfg, f, {
      anomaly: anomaly ? anomaly.rarity : 0,
      linked: cid ? 1 : 0,
      cluster_internal_share: cid ? this.clusterInternalShare(cid, now) : 0,
    });
    const z = this.cfg.engine.scoring.interval_z;
    return {
      f,
      x,
      champion: score(this.models.champion, x, z),
      challenger: this.models.challenger ? score(this.models.challenger, x, z) : null,
      anomaly,
    };
  }

  private reasons(acct: string, r: AccountScore): Record<string, unknown> {
    const cid = this.clusterOf(acct);
    const rules = Object.entries(r.champion.contributions)
      .filter(([k]) => k.startsWith("rule:"))
      .map(([k, w]) => ({ rule: k.slice(5), log_odds: Math.round(w * 100) / 100 }))
      .sort((a, b) => b.log_odds - a.log_odds);
    const out: Record<string, unknown> = {
      p: Math.round(r.champion.p * 1000) / 1000,
      interval_80: [Math.round(r.champion.lo * 1000) / 1000, Math.round(r.champion.hi * 1000) / 1000],
      rules,
    };
    if (r.anomaly) {
      out.anomaly = {
        score: Math.round(r.anomaly.score * 1000) / 1000,
        rarity: Math.round(r.anomaly.rarity * 100) / 100,
        log_odds: Math.round((r.champion.contributions.anomaly ?? 0) * 100) / 100,
        unusual: r.anomaly.top.map((t) => ({ feature: t.feature, robust_z: Math.round(t.z * 10) / 10 })),
      };
    }
    if (cid) {
      const members = this.clusterMembers.get(cid) ?? [];
      let best: { other: string; score: number; evidence: Record<string, unknown> } | null = null;
      for (const m of members) {
        if (m === acct) continue;
        const key = acct < m ? `${acct}|${m}` : `${m}|${acct}`;
        const l = this.linkEvidence.get(key);
        if (l && (!best || l.score > best.score)) best = { other: m, ...l };
      }
      out.cluster = { id: cid, size: members.length, strongest_link: best };
    }
    return out;
  }

  private processEvent(ev: EngineEvent): void {
    let s = this.states.get(ev.account_id);
    if (!s) {
      s = newState(this.opened.get(ev.account_id) ?? ev.ts, ev.ts);
      this.states.set(ev.account_id, s);
    }
    applyEvent(s, ev, { indexPrice: (c, t) => this.prices.at(c, t), clusterOf: this.clusterOf }, this.cfg.engine.state);
    this.evidence.onEvent(ev, (c, t) => this.prices.at(c, t));
    this.dirty.add(ev.account_id);
    const cid = this.clusterOf(ev.account_id);
    if (cid) this.dirtyClusters.add(cid);
    // Market makers still feed state and linking, but are not scored as retail accounts.
    if (!SCORED.has(ev.kind) || this.marketMakers.has(ev.account_id)) return;

    const r = this.scoreAccount(ev.account_id, ev.ts);
    this.latest.set(ev.account_id, r);
    const day = dayOf(ev.ts);
    const key = `${ev.account_id}|${day}`;
    const cur = this.dailyMax.get(key);
    if (!cur || r.champion.p > cur.p) this.dailyMax.set(key, { account: ev.account_id, day, p: r.champion.p, x: r.x });

    let check = this.book.check(ev.account_id, cid, r.champion.p, ev.ts, this.threshold);
    let lane: "score" | "anomaly" = "score";
    // Notice: a few slots a day for accounts that break pattern hard without
    // tripping a rule. Without them the scorer never sees a verdict on what no
    // rule covers, and the forest's weight could never be learned.
    const L = this.cfg.engine.alerts.anomaly_lane;
    if (!check.alert && check.why === "below_threshold" && r.anomaly && r.anomaly.rarity >= L.min_rarity && (this.laneCount.get(day) ?? 0) < L.daily_budget) {
      check = this.book.check(ev.account_id, cid, r.champion.p, ev.ts, 0);
      if (check.alert) {
        lane = "anomaly";
        this.laneCount.set(day, (this.laneCount.get(day) ?? 0) + 1);
      }
    }
    if (!check.alert) return;
    if (lane === "score") {
      // Hard cap: analysts can work `daily_budget` alerts a day. Within a day it is first come,
      // first served, which is the price of deciding in real time; the nightly threshold is
      // what keeps the cap from binding on most days.
      if ((this.scoreCount.get(day) ?? 0) >= this.cfg.engine.alerts.daily_budget) {
        this.capped.set(day, (this.capped.get(day) ?? 0) + 1);
        return;
      }
      this.scoreCount.set(day, (this.scoreCount.get(day) ?? 0) + 1);
    }
    const scores: DecisionRow["scores"] = { [r.champion.version]: { p: r.champion.p, lo: r.champion.lo, hi: r.champion.hi } };
    if (r.challenger) scores[r.challenger.version] = { p: r.challenger.p, lo: r.challenger.lo, hi: r.challenger.hi };
    this.decisions.push({
      ts: ev.ts,
      account_id: ev.account_id,
      cluster_id: cid,
      x: r.x,
      scores,
      champion: r.champion.version,
      p: r.champion.p,
      threshold: this.threshold,
      reasons: { lane, ...this.reasons(ev.account_id, r) },
    });
    this.book.record(ev.account_id, cid, r.champion.p, ev.ts);
  }

  /**
   * Read and process one batch. With `until`, only events at or before that
   * event time are taken (replay). Returns the number of events processed.
   */
  async step(opts: { until?: number; batchSize?: number; live?: boolean } = {}): Promise<number> {
    const until = new Date(opts.until ?? 8.64e15);
    const ev = await this.db.query(
      "SELECT id, ts, account_id, kind, payload FROM events WHERE id > $1 AND ts <= $2 ORDER BY id LIMIT $3",
      [this.cursor.event, until, opts.batchSize ?? 2000],
    );
    if (!ev.rows.length) return 0;
    const events: EngineEvent[] = ev.rows.map((r) => ({ id: r.id, ts: new Date(r.ts).getTime(), account_id: r.account_id, kind: r.kind, payload: r.payload }));
    const maxTs = Math.max(...events.map((e) => e.ts));
    const px = await this.db.query("SELECT id, ts, contract, price FROM index_prices WHERE id > $1 AND ts <= $2 ORDER BY id", [this.cursor.price, new Date(maxTs)]);
    for (const r of px.rows) this.prices.add(r.contract, new Date(r.ts).getTime(), r.price);
    if (px.rows.length) this.cursor.price = px.rows[px.rows.length - 1].id;

    for (const e of events) this.processEvent(e);
    this.cursor.event = events[events.length - 1].id;
    this.cursor.eventTime = Math.max(this.cursor.eventTime, maxTs);
    await this.flush(events, opts.live ?? false);
    this.prices.trim(this.cursor.eventTime);
    this.evidence.trim(this.cursor.eventTime);
    return events.length;
  }

  private async flush(events: EngineEvent[], live: boolean): Promise<void> {
    const now = this.cursor.eventTime;
    const at = new Date(now);
    await withTx(this.db, async (tx) => {
      if (this.dirty.size) {
        const ids = [...this.dirty];
        const sc = ids.map((a) => this.latest.get(a));
        await tx.query(
          `INSERT INTO account_state (account_id, event_time, state, features, score)
           SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::jsonb[], $4::jsonb[], $5::jsonb[])
           ON CONFLICT (account_id) DO UPDATE SET event_time = EXCLUDED.event_time, state = EXCLUDED.state,
             features = EXCLUDED.features, score = COALESCE(EXCLUDED.score, account_state.score)`,
          [
            ids,
            ids.map((a) => new Date(this.states.get(a)!.t)),
            ids.map((a) => JSON.stringify(this.states.get(a))),
            ids.map((a) => JSON.stringify(features(this.states.get(a)!, this.states.get(a)!.t, this.cfg.engine.state))),
            sc.map((r) =>
              r
                ? JSON.stringify({
                    version: r.champion.version,
                    p: r.champion.p,
                    lo: r.champion.lo,
                    hi: r.champion.hi,
                    anomaly: r.anomaly?.score ?? null,
                    challenger: r.challenger ? { version: r.challenger.version, p: r.challenger.p } : null,
                  })
                : null,
            ),
          ],
        );
      }
      for (const cid of this.dirtyClusters) {
        const members = this.clusterMembers.get(cid) ?? [];
        let notional = 0;
        let maxP = 0;
        for (const m of members) {
          const s = this.states.get(m);
          if (s) notional += s.notional_l * decayFactor(now - s.t, this.cfg.engine.state.long_half_life_minutes);
          maxP = Math.max(maxP, this.latest.get(m)?.champion.p ?? 0);
        }
        await tx.query(
          `INSERT INTO cluster_state (cluster_id, event_time, features) VALUES ($1, $2, $3)
           ON CONFLICT (cluster_id) DO UPDATE SET event_time = EXCLUDED.event_time, features = EXCLUDED.features`,
          [cid, at, JSON.stringify({ size: members.length, fill_notional_24h: notional, internal_share: this.clusterInternalShare(cid, now), max_member_p: maxP })],
        );
      }
      await this.evidence.flush(tx, at);
      for (const d of this.decisions) {
        await tx.query(
          `INSERT INTO decisions (ts, day, account_id, cluster_id, kind, x, scores, champion, p, threshold, weight, reasons)
           VALUES ($1, $2, $3, $4, 'alert', $5, $6, $7, $8, $9, 1, $10)`,
          [new Date(d.ts), dayOf(d.ts), d.account_id, d.cluster_id, JSON.stringify(d.x), JSON.stringify(d.scores), d.champion, d.p, d.threshold, JSON.stringify(d.reasons)],
        );
      }
      if (this.dailyMax.size) {
        const rows = [...this.dailyMax.values()];
        await tx.query(
          `INSERT INTO daily_scores (account_id, day, max_p, x)
           SELECT * FROM unnest($1::text[], $2::date[], $3::float8[], $4::jsonb[])
           ON CONFLICT (account_id, day) DO UPDATE SET max_p = EXCLUDED.max_p, x = EXCLUDED.x
           WHERE daily_scores.max_p < EXCLUDED.max_p`,
          [rows.map((r) => r.account), rows.map((r) => r.day), rows.map((r) => r.p), rows.map((r) => JSON.stringify(r.x))],
        );
      }
      await tx.query(
        `INSERT INTO consumer_cursor (consumer, last_event_id, last_price_id, event_time) VALUES ($1, $2, $3, $4)
         ON CONFLICT (consumer) DO UPDATE SET last_event_id = EXCLUDED.last_event_id, last_price_id = EXCLUDED.last_price_id, event_time = EXCLUDED.event_time`,
        [this.consumer, this.cursor.event, this.cursor.price, at],
      );
      if (live) {
        // Freshness: commit time minus event time, per event in the batch.
        const commit = Date.now();
        const lags = events.map((e) => commit - e.ts).sort((a, b) => a - b);
        await tx.query("INSERT INTO engine_metrics (ts, mode, events, lag_p50_ms, lag_p95_ms) VALUES ($1, 'live', $2, $3, $4)", [
          new Date(commit), events.length, quantile(lags, 0.5), quantile(lags, 0.95),
        ]);
      }
    });
    this.dirty.clear();
    this.dirtyClusters.clear();
    this.decisions = [];
    this.dailyMax.clear();
  }

  /** Process everything up to event time `until` (replay). */
  async runUntil(until: number): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.step({ until });
      if (!n) return total;
      total += n;
    }
  }
}
