import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { Engine } from "../src/engine/engine.js";
import { seed } from "../src/sim/seed.js";
import { dayStart, HOUR } from "../src/util.js";
import { freshDb } from "./helpers.js";

const cfg = loadConfig();
let db: Db;

async function snapshot(db: Db) {
  const s = await db.query("SELECT account_id, state FROM account_state ORDER BY account_id");
  const e = await db.query("SELECT a, b, kind, value, detail FROM pair_evidence ORDER BY a, b, kind");
  const i = await db.query("SELECT kind, value, account_id, first_seen, last_seen FROM identifiers ORDER BY kind, value, account_id");
  const d = await db.query("SELECT ts, account_id, p, reasons FROM decisions ORDER BY ts, account_id");
  const c = await db.query("SELECT last_event_id, last_price_id FROM consumer_cursor");
  return { states: s.rows, evidence: e.rows, identifiers: i.rows, decisions: d.rows, cursor: c.rows };
}

beforeAll(async () => {
  db = await freshDb();
  await seed(db, { seed: 3, start: "2026-03-02", days: 2, accounts: 400 }, () => {});
});
afterAll(async () => db.end());

describe("stream consumer", () => {
  it("a restart mid-stream ends in exactly the state of an uninterrupted run", async () => {
    const end = dayStart("2026-03-04");
    // crash and restart every two hours of event time; everything reloads from Postgres
    for (let t = dayStart("2026-03-02") + 2 * HOUR + 7 * 60_000; t < end; t += 2 * HOUR) {
      const e = new Engine(db, cfg);
      await e.init();
      await e.runUntil(t);
    }
    const last = new Engine(db, cfg);
    await last.init();
    await last.runUntil(end);
    const restarted = await snapshot(db);

    await db.query("TRUNCATE account_state, consumer_cursor, pair_evidence, identifiers, decisions, daily_scores, cluster_state, engine_metrics");
    const straight = new Engine(db, cfg);
    await straight.init();
    await straight.runUntil(end);
    const uninterrupted = await snapshot(db);

    expect(restarted.states.length).toBeGreaterThan(300);
    expect(restarted.evidence.length).toBeGreaterThan(0);
    expect(restarted).toEqual(uninterrupted);
  });

  it("processes every event once and then has nothing left to read", async () => {
    const max = (await db.query("SELECT max(id) AS m FROM events")).rows[0].m;
    const e = new Engine(db, cfg);
    await e.init();
    expect(e.cursor.event).toBe(max);
    expect(await e.step()).toBe(0);
  });

  it("writes one alert per account until a verdict arrives", async () => {
    const r = await db.query(
      `SELECT account_id, count(*) AS n FROM decisions WHERE kind = 'alert' AND verdict IS NULL GROUP BY account_id HAVING count(*) > 1`,
    );
    expect(r.rows).toEqual([]);
  });
});
