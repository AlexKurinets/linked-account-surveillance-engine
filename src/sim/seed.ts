import type { Db } from "../db.js";
import { getConfigValue, setConfigValue } from "../db.js";
import { addDays, DAY, dayOf, dayStart, Rng } from "../util.js";
import { buildWorld, CONTRACTS, dayEvents, dayPrices, type SimEvent, type World, type WorldOptions } from "./world.js";

async function insertEvents(db: Db, events: SimEvent[]): Promise<void> {
  for (let i = 0; i < events.length; i += 5000) {
    const chunk = events.slice(i, i + 5000);
    await db.query(
      `INSERT INTO events (ts, account_id, kind, payload)
       SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::jsonb[])`,
      [chunk.map((e) => new Date(e.ts)), chunk.map((e) => e.account_id), chunk.map((e) => e.kind), chunk.map((e) => JSON.stringify(e.payload))],
    );
  }
}

async function insertPrices(db: Db, prices: { ts: number; contract: string; price: number }[]): Promise<void> {
  for (let i = 0; i < prices.length; i += 10000) {
    const chunk = prices.slice(i, i + 10000);
    await db.query(
      `INSERT INTO index_prices (ts, contract, price) SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::float8[])`,
      [chunk.map((p) => new Date(p.ts)), chunk.map((p) => p.contract), chunk.map((p) => p.price)],
    );
  }
}

export function defaultStart(now = Date.now(), days = 14): string {
  return addDays(dayOf(now), -days);
}

/** Write the synthetic world and its full history. Refuses to run twice on the same database. */
export async function seed(db: Db, o: WorldOptions, log = console.log): Promise<{ events: number; prices: number }> {
  if (await getConfigValue(db, "world")) throw new Error("database already seeded; use a fresh database to reseed");
  const world = buildWorld(o);
  await db.query(
    `INSERT INTO accounts (account_id, opened_at, tier) SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[])`,
    [world.accounts.map((a) => a.id), world.accounts.map((a) => new Date(a.opened)), world.accounts.map((a) => (a.role === "market_maker" ? "market_maker" : "retail"))],
  );
  await db.query(
    `INSERT INTO sim_truth (account_id, role, group_id) SELECT * FROM unnest($1::text[], $2::text[], $3::text[])`,
    [world.accounts.map((a) => a.id), world.accounts.map((a) => a.role), world.accounts.map((a) => a.group)],
  );
  let events = 0;
  let prices = 0;
  for (let d = 0; d < o.days; d++) {
    const px = dayPrices(world, d);
    const ev = dayEvents(world, d, px);
    await insertPrices(db, px);
    await insertEvents(db, ev);
    events += ev.length;
    prices += px.length;
    log(`seeded ${addDays(o.start, d)}: ${ev.length} events`);
  }
  await setConfigValue(db, "world", o, new Date(dayStart(o.start) + o.days * DAY));
  return { events, prices };
}

export async function loadWorld(db: Db): Promise<World> {
  const o = await getConfigValue<WorldOptions>(db, "world");
  if (!o) throw new Error("database is not seeded");
  return buildWorld(o);
}

/**
 * Live feed: today's events from the same world, emitted as wall-clock time
 * reaches them, plus index ticks every 250 ms per contract that follow the same
 * price path the fills were priced from. `mmRate` adds market-maker order flow
 * (orders per second) to load-test the consumer.
 */
export async function runLive(db: Db, opts: { mmRate: number; mmOnly?: boolean; stopAfterMs?: number }, log = console.log): Promise<void> {
  const world = await loadWorld(db);
  const rng = new Rng(Date.now() % 2 ** 31);
  const maxTs = (await db.query("SELECT max(ts) AS t FROM events")).rows[0].t;
  let last = Math.max(Date.now(), maxTs ? new Date(maxTs).getTime() : 0);
  let planDay = "";
  let plan: SimEvent[] = [];
  let minutePx: { ts: number; contract: string; price: number }[] = [];
  const started = Date.now();
  let emitted = 0;
  for (;;) {
    const now = Date.now();
    const today = dayOf(now);
    if (today !== planDay) {
      const idx = Math.round((dayStart(today) - dayStart(world.start)) / DAY);
      minutePx = dayPrices(world, idx);
      plan = dayEvents(world, idx, minutePx);
      planDay = today;
      log(`live plan for ${today}: ${plan.length} events`);
    }
    // --mm-only: load-test flow alongside a running feed without duplicating its events or ticks
    const due = opts.mmOnly ? [] : plan.filter((e) => e.ts > last && e.ts <= now);
    for (let i = 0; i < opts.mmRate * 0.25; i++) {
      const mm = rng.pick(world.marketMakers);
      const contract = rng.pick(CONTRACTS);
      due.push({ ts: now, account_id: mm, kind: "order", payload: { contract } });
      due.push({ ts: now, account_id: mm, kind: "cancel", payload: { contract } });
    }
    const minute = Math.floor((now - dayStart(today)) / 60_000);
    const ticks = CONTRACTS.map((c) => {
      const base = minutePx.filter((p) => p.contract === c)[Math.min(minute, 1439)].price;
      return { ts: now, contract: c, price: base * (1 + 0.00005 * rng.normal()) };
    });
    if (!opts.mmOnly) await insertPrices(db, ticks);
    if (due.length) {
      await insertEvents(db, due);
      await db.query("NOTIFY events");
      emitted += due.length;
    }
    last = now;
    if (opts.stopAfterMs && now - started > opts.stopAfterMs) {
      log(`live feed stopped after ${emitted} events`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
