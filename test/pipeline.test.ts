import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeReportModel, ScriptedReportModel } from "../src/agent/model.js";
import { buildApi } from "../src/api.js";
import { runReport } from "../src/agent/report.js";
import { getOpenItems } from "../src/agent/tools.js";
import { checkReport } from "../src/agent/validate.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { evaluatePublished, loadTruth } from "../src/linking/evaluate.js";
import { replay } from "../src/jobs.js";
import { seed } from "../src/sim/seed.js";
import { freshDb, TEST_DB } from "./helpers.js";

/**
 * The whole system on a small synthetic world: seed, replay five days through
 * the consumer, the Python co-activity batch, the linker, verdicts, audits,
 * scorecards, shadow promotion and the report agent.
 */
const cfg = loadConfig();
const DAYS = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"];
let db: Db;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DB; // the Python worker reads it
  db = await freshDb();
  await seed(db, { seed: 5, start: DAYS[0], days: DAYS.length, accounts: 900 }, () => {});
  await replay(db, cfg, () => {});
});
afterAll(async () => db.end());

describe("replayed pipeline", () => {
  it("scores every day and publishes a checked report for each", async () => {
    const s = await db.query("SELECT day FROM scorecard_daily ORDER BY day");
    expect(s.rows.map((r) => r.day)).toEqual(DAYS);
    const r = await db.query("SELECT day, source, attempts, check_errors FROM reports ORDER BY day");
    expect(r.rows.map((x) => x.day)).toEqual(DAYS);
    for (const row of r.rows) {
      expect(row.source).toBe("agent");
      expect(row.check_errors).toEqual([]);
    }
  });

  it("links accounts run by one person without linking households or market makers", async () => {
    const ev = await evaluatePublished(db, await loadTruth(db));
    expect(ev.clusters).toBeGreaterThan(0);
    expect(ev.precision!).toBeGreaterThanOrEqual(0.9);
    expect(ev.household_pairs_linked).toBe(0);
    expect(ev.market_maker_pairs_linked).toBe(0);
    expect(ev.largest_cluster).toBeLessThanOrEqual(cfg.engine.linking.max_cluster_size);
  });

  it("explains every alert with a probability, an interval and its reasons", async () => {
    const r = await db.query("SELECT p, reasons FROM decisions WHERE kind = 'alert'");
    expect(r.rows.length).toBeGreaterThan(10);
    for (const a of r.rows) {
      const [lo, hi] = a.reasons.interval_80;
      expect(lo).toBeLessThanOrEqual(a.p + 1e-3);
      expect(hi).toBeGreaterThanOrEqual(a.p - 1e-3);
      expect(["score", "anomaly"]).toContain(a.reasons.lane);
    }
    const clustered = r.rows.filter((a) => a.reasons.cluster);
    expect(clustered.length).toBeGreaterThan(0);
    expect(clustered[0].reasons.cluster.strongest_link.evidence.families.length).toBeGreaterThanOrEqual(2);
  });

  it("gives every alert a verdict once enough time has passed, and samples non-alerted accounts", async () => {
    const pending = await db.query("SELECT count(*) AS n FROM decisions WHERE kind = 'alert' AND verdict IS NULL AND day < $1", [DAYS[4]]);
    expect(Number(pending.rows[0].n)).toBe(0);
    const audits = await db.query("SELECT weight FROM decisions WHERE kind = 'audit'");
    expect(audits.rows.length).toBeGreaterThan(5);
    for (const a of audits.rows) expect(a.weight).toBeGreaterThan(1);
  });

  it("refits on verdicts and judges each refit in shadow before it can go live", async () => {
    const m = await db.query("SELECT version, status, metrics FROM models WHERE kind = 'score' AND version <> 'analyst-v1'");
    expect(m.rows.length).toBeGreaterThan(0);
    const decided = m.rows.filter((x) => x.status !== "challenger");
    for (const x of decided) expect(x.metrics.shadow.cases).toBeGreaterThanOrEqual(cfg.engine.outcomes.shadow_min_cases);
    expect(m.rows.filter((x) => x.status === "challenger").length).toBeLessThanOrEqual(1);
  });

  it("serves the read API", async () => {
    const app = buildApi(db, cfg);
    for (const url of ["/health", "/scorecard", "/clusters", "/alerts", "/models", "/reports/latest", "/open-items", "/metrics/freshness", "/linking/evaluation"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
    const c = (await app.inject({ method: "GET", url: "/clusters" })).json();
    const one = await app.inject({ method: "GET", url: `/clusters/${c.clusters[0].cluster_id}` });
    expect(one.json().links.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/clusters/C00000" })).statusCode).toBe(404);
    await app.close();
  });

  it("does nothing when replayed again", async () => {
    const before = await db.query("SELECT count(*) AS n FROM decisions");
    await replay(db, cfg, () => {});
    const after = await db.query("SELECT count(*) AS n FROM decisions");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("report agent", () => {
  const day = DAYS[4];

  it("sends Claude the documented request shape (fake client, no API call)", async () => {
    const sent: any[] = [];
    const scripted = new ScriptedReportModel();
    const fake = { beta: { messages: { create: async (params: any) => { sent.push(structuredClone(params)); return scripted.next(params); } } } };
    const out = await runReport(db, day, new ClaudeReportModel(fake as any, "claude-opus-5-5"), cfg);
    expect(out.source).toBe("agent");
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const p = sent[0];
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toContain("server-side-fallback-2026-07-01");
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.tools.map((t: any) => t.name)).toEqual(["get_scorecard", "list_alerts", "get_cluster", "get_model_changes", "get_open_items", "update_open_items"]);
    for (const t of p.tools) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
    }
    // every tool result goes back in a single user message after each tool turn
    const withResults = sent[1].messages[sent[1].messages.length - 1];
    expect(withResults.role).toBe("user");
    expect(withResults.content.every((b: any) => b.type === "tool_result")).toBe(true);
  });

  it("sends a draft with a self-computed total back once, then publishes the corrected one", async () => {
    const out = await runReport(db, day, new ScriptedReportModel(1), cfg);
    expect(out.source).toBe("agent");
    expect(out.attempts).toBe(2);
    expect(out.errors[0].join(" ")).toMatch(/numbers not found in any tool result/);
  });

  it("falls back to the template report and pages after two failed drafts", async () => {
    const pagesBefore = Number((await db.query("SELECT count(*) AS n FROM pages")).rows[0].n);
    const out = await runReport(db, day, new ScriptedReportModel(0, 2), cfg);
    expect(out.source).toBe("template");
    expect(out.errors).toHaveLength(2);
    const pagesAfter = Number((await db.query("SELECT count(*) AS n FROM pages")).rows[0].n);
    expect(pagesAfter).toBe(pagesBefore + 1);
    const md = (await db.query("SELECT markdown FROM reports WHERE day = $1", [day])).rows[0].markdown;
    expect(md).toContain("template fallback");
  });

  it("rejects drafts that cite unknown ids or drop an open item", async () => {
    const open = await getOpenItems(db);
    expect(open.length).toBeGreaterThan(0);
    const draft = {
      day,
      summary: "Cluster C99999 needs a look; nothing else happened today at all.",
      decisions_needed: [],
      closed_items: [],
      changes: [],
    };
    const res = await checkReport(JSON.stringify(draft), { db, cfg, day, results: [], openAtStart: open, staged: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("unknown cluster C99999"))).toBe(true);
      expect(res.errors.some((e) => e.includes("neither carried nor closed"))).toBe(true);
    }
  });

  it("remembers between runs: yesterday's open items are carried or closed today", async () => {
    // days 3 and 4: the tests above re-run day 5, which moves its memory baseline
    const r = await db.query("SELECT report FROM reports WHERE day = $1", [DAYS[2]]);
    const prev = r.rows[0].report;
    const today = (await db.query("SELECT report FROM reports WHERE day = $1", [DAYS[3]])).rows[0].report;
    const keys = (xs: any[]) => new Set(xs.map((x) => `${x.subject_type}:${x.subject_id}`));
    const carriedOrClosed = new Set([...keys(today.decisions_needed), ...keys(today.closed_items)]);
    for (const k of keys(prev.decisions_needed)) expect(carriedOrClosed.has(k)).toBe(true);
  });
});
