import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { groundedNumbers, ungroundedNumbers } from "../src/agent/validate.js";
import { loadConfig, scoreFeatureNames } from "../src/config.js";
import { anomalyRarity, anomalyScore, averagePathLength, type AnomalyModel } from "../src/engine/anomaly.js";
import { IndexPrices } from "../src/engine/indexPrices.js";
import { analystModel, ruleFires, score, scoreInputs } from "../src/engine/scoring.js";
import { applyEvent, decayFactor, type EngineEvent, features, newState } from "../src/engine/state.js";
import { clusterId, clusterLinks } from "../src/linking/cluster.js";
import { identifierWeight, type PairEvidence, scoreFamilies } from "../src/linking/families.js";
import { DAY, HOUR, MINUTE } from "../src/util.js";

const cfg = loadConfig();
const sc = cfg.engine.state;
const ctx = { indexPrice: () => 100, clusterOf: () => null };
let id = 0;
const ev = (ts: number, kind: EngineEvent["kind"], payload: Record<string, unknown> = {}): EngineEvent => ({ id: ++id, ts, account_id: "A10001", kind, payload });

describe("decayed state", () => {
  it("halves a counter every half-life", () => {
    expect(decayFactor(60 * MINUTE, 60)).toBeCloseTo(0.5, 12);
    const s = newState(0, 0);
    applyEvent(s, ev(0, "order"), ctx, sc);
    expect(features(s, 60 * MINUTE, sc).orders_1h).toBeCloseTo(0.5, 12);
    expect(features(s, 120 * MINUTE, sc).orders_1h).toBeCloseTo(0.25, 12);
  });

  it("reads off-index distance and counterparty concentration from fills", () => {
    const s = newState(0, 0);
    applyEvent(s, ev(1000, "fill", { contract: "C1-PERP", price: 102, notional: 30000, counterparty: "A10002" }), ctx, sc);
    applyEvent(s, ev(2000, "fill", { contract: "C1-PERP", price: 100, notional: 10000, counterparty: "A10003" }), ctx, sc);
    const f = features(s, 2000, sc);
    expect(f.off_index_bps_24h).toBeCloseTo(150, 0); // 200 bps on 75% of the notional
    expect(f.top_counterparty_share_24h).toBeCloseTo(0.75, 3);
  });

  it("forgets devices after seven days and measures deposit-to-withdrawal time", () => {
    const s = newState(0, 0);
    applyEvent(s, ev(0, "session_start", { device: "d1", ip: "10.0.0.1" }), ctx, sc);
    applyEvent(s, ev(DAY, "session_start", { device: "d2", ip: "10.0.0.1" }), ctx, sc);
    expect(features(s, DAY, sc).devices_7d).toBe(2);
    // at 7.5 days d1 (seen at day 0) has dropped out and d2 (seen at day 1) has not
    applyEvent(s, ev(7.5 * DAY, "deposit", { amount: 5000 }), ctx, sc);
    applyEvent(s, ev(7.5 * DAY + 40 * MINUTE, "withdrawal", { amount: 4800, address: "x" }), ctx, sc);
    const f = features(s, 7.5 * DAY + 41 * MINUTE, sc);
    expect(f.devices_7d).toBe(1);
    expect(f.in_out_minutes).toBeCloseTo(40, 6);
    expect(f.withdraw_ratio_24h).toBeGreaterThan(0.9);
  });
});

describe("index prices", () => {
  it("answers the last price at or before a time", () => {
    const p = new IndexPrices();
    p.add("C1-PERP", 1000, 10);
    p.add("C1-PERP", 3000, 30);
    p.add("C1-PERP", 2000, 20); // out of order
    expect(p.at("C1-PERP", 999)).toBeNull();
    expect(p.at("C1-PERP", 2500)).toBe(20);
    expect(p.at("C1-PERP", 9999)).toBe(30);
  });
});

describe("scoring", () => {
  it("evaluates analyst rules without running code", () => {
    const rule = cfg.rules.find((r) => r.id === "off_index_fills")!;
    expect(ruleFires(rule, { off_index_bps_24h: 90, fill_notional_24h: 25000 })).toBe(true);
    expect(ruleFires(rule, { off_index_bps_24h: 90, fill_notional_24h: 15000 })).toBe(false);
    expect(ruleFires(rule, {})).toBe(false);
  });

  it("starts from exactly the analysts' weights", () => {
    const m = analystModel(cfg);
    expect(m.features).toEqual(scoreFeatureNames(cfg));
    for (const r of cfg.rules) expect(m.mean[m.features.indexOf(`rule:${r.id}`)]).toBe(r.weight);
  });

  it("puts an interval around the probability that widens with weight uncertainty", () => {
    const m = analystModel(cfg);
    const x = scoreInputs(cfg, { devices_7d: 4 }, {});
    const wide = score(m, x, 1.2816);
    const sure = score({ ...m, cov: m.cov.map((row) => row.map(() => 0)) }, x, 1.2816);
    expect(wide.p).toBeCloseTo(sure.p, 12);
    expect(sure.hi - sure.lo).toBeCloseTo(0, 12);
    expect(wide.lo).toBeLessThan(wide.p);
    expect(wide.hi).toBeGreaterThan(wide.p);
    expect(wide.contributions["rule:many_devices"]).toBe(3);
  });
});

describe("isolation forest parity with scikit-learn", () => {
  const fx = JSON.parse(fs.readFileSync("test/fixtures/iforest_parity.json", "utf8"));
  const model = fx.model as AnomalyModel;

  it("matches score_samples to 1e-9 on every probe", () => {
    const worst = Math.max(...fx.inputs.map((x: number[], i: number) => Math.abs(anomalyScore(model, x) - fx.expected[i])));
    expect(worst).toBeLessThan(1e-9);
  });

  it("uses scikit-learn's c(n)", () => {
    expect(averagePathLength(1)).toBe(0);
    expect(averagePathLength(2)).toBe(1);
    expect(averagePathLength(256)).toBeCloseTo(2 * (Math.log(255) + 0.5772156649015329) - (2 * 255) / 256, 12);
  });

  it("turns a score into rarity: 0 at the median, 2 at the top 1%", () => {
    const q = model.score_quantiles;
    expect(anomalyRarity(model, q[500])).toBeCloseTo(-Math.log10(0.5), 2);
    expect(anomalyRarity(model, q[990])).toBeCloseTo(2, 1);
    expect(anomalyRarity(model, q[1000] + 1)).toBe(4);
  });
});

describe("linking", () => {
  const L = cfg.engine.linking;
  const N = 3000;
  const pop = (ip: string) => (ip.startsWith("100.64.") ? 900 : 2);
  const pair = (e: Partial<PairEvidence>): PairEvidence => ({ a: "A10001", b: "A10002", shared: [], ...e });

  it("weights identifiers by rarity and ignores them past the cap", () => {
    expect(identifierWeight(2, N, L)).toBeCloseTo(Math.log(1500), 12);
    expect(identifierWeight(26, N, L)).toBe(0);
    expect(identifierWeight(400, N, { ...L, rarity_weighting: false })).toBeCloseTo(Math.log(1500), 12);
  });

  it("keeps a household on one laptop apart: identity alone is one family", () => {
    const s = scoreFamilies(pair({ shared: [{ kind: "device", value: "dev-1", k: 2 }], ipCoincident: { count: 6, ips: { "10.1.2.3": 6 } } }), N, pop, L);
    expect(s.families).toEqual(["identity"]);
    expect(s.linked).toBe(false);
    expect(scoreFamilies(pair({ shared: [{ kind: "device", value: "dev-1", k: 2 }] }), N, pop, { ...L, require_two_families: false }).linked).toBe(true);
  });

  it("gives carrier NAT addresses no weight", () => {
    const s = scoreFamilies(pair({ ipCoincident: { count: 9, ips: { "100.64.0.3": 9 } } }), N, pop, L);
    expect(s.identity).toBe(0);
  });

  it("links an operator: handoffs on one device plus off-index fills between the two", () => {
    const s = scoreFamilies(
      pair({ shared: [{ kind: "device", value: "dev-9", k: 2 }], handoff: { count: 6, device: 6, ips: {} }, pairFills: { count: 12, notional: 120000, dev_notional: 120000 * 180 } }),
      N, pop, L,
    );
    expect(s.families).toEqual(["identity", "timing", "money"]);
    expect(s.linked).toBe(true);
  });

  it("does not link two market makers that only trade with each other", () => {
    const s = scoreFamilies(pair({ pairFills: { count: 400, notional: 4e6, dev_notional: 4e6 * 1 } }), N, pop, L);
    expect(s.families).toEqual(["money"]);
    expect(s.linked).toBe(false);
  });

  it("refuses merges past the size cap and names clusters after their smallest member", () => {
    const links = [];
    for (let i = 1; i < 14; i++) links.push({ a: "A10000", b: `A100${String(i).padStart(2, "0")}`, score: 20 - i });
    const c = clusterLinks(links, 10);
    expect([...c.clusters.values()][0]).toHaveLength(10);
    expect(c.refused).toHaveLength(4);
    expect(clusterId(["A10200", "A10007", "A10150"])).toBe("C10007");
  });
});

describe("number grounding", () => {
  it("accepts numbers that appear in tool results, rounded or not, and rejects sums", () => {
    const grounded = groundedNumbers([{ alerts: 37, precision_pct: 62.5, threshold: 0.4123 }, { band: "10-20%" }]);
    const report = { day: "2026-03-05", summary: "37 alerts, precision 62.5%, threshold 0.41, band 10-20%.", decisions_needed: [], closed_items: [], changes: ["74 alerts in two days"] };
    expect(ungroundedNumbers(report, grounded)).toEqual(["74"]);
  });

  it("ignores ids and dates", () => {
    const report = { day: "2026-03-05", summary: "Cluster C10023 and account A10077 on 2026-03-05, alert AL-991, model score-20260304T2359.", decisions_needed: [], closed_items: [], changes: [] };
    expect(ungroundedNumbers(report, new Set())).toEqual([]);
  });
});

void HOUR;
