import { DAY, dayStart, HOUR, MINUTE, Rng } from "../util.js";

/**
 * A synthetic derivatives venue. Every name, address, device and figure here is
 * made up. The world is built so that each linking safeguard has something real
 * to do:
 *  - rings: several accounts run by one operator, in parallel (shared minutes)
 *    or one after another (session handoffs), most trading with each other
 *  - households: two people on one laptop and one home IP, otherwise independent
 *  - carrier NAT: a third of sessions come from a handful of shared 100.64.x.x IPs
 *  - an office computer used now and then by 40 unrelated accounts
 *  - market makers that trade with each other all day
 *  - mules (deposit, withdraw within the hour) and spoofers (order floods that
 *    cancel almost everything, a pattern no analyst rule covers)
 */
export const CONTRACTS = ["C1-PERP", "C2-PERP", "C3-PERP", "C4-PERP", "C5-PERP"] as const;
const START_PRICE: Record<string, number> = { "C1-PERP": 41000, "C2-PERP": 2400, "C3-PERP": 96, "C4-PERP": 0.82, "C5-PERP": 0.31 };
const NAT_IPS = Array.from({ length: 8 }, (_, i) => `100.64.0.${i + 1}`);
const OFFICE_DEVICE = "dev-office-01";
const OFFICE_IP = "10.200.0.1";

export type Role = "normal" | "market_maker" | "ring" | "household" | "mule" | "spoofer";

export interface Account {
  id: string;
  role: Role;
  group: string | null;
  opened: number;
  tz: number;
  activeProb: number;
  devices: string[];
  homeIp: string | null;
  mobileShare: number;
  payout: string;
  office: boolean;
  /** first day index on which a bad actor is active; 0 for everyone else */
  onset: number;
}

export interface Ring {
  id: string;
  members: string[];
  mode: "parallel" | "sequential";
  sharedDevice: string | null;
  vpn: boolean;
  trades: "transfer" | "wash" | "none";
  sharedPayout: string | null;
  tz: number;
  homeIp: string;
  onset: number;
}

export interface World {
  seed: number;
  start: string;
  days: number;
  accounts: Account[];
  byId: Map<string, Account>;
  rings: Ring[];
  marketMakers: string[];
}

export interface SimEvent {
  ts: number;
  account_id: string;
  kind: "session_start" | "session_end" | "order" | "cancel" | "fill" | "deposit" | "withdrawal";
  payload: Record<string, unknown>;
}

export interface WorldOptions {
  seed: number;
  start: string;
  days: number;
  accounts: number;
}

const hex = (rng: Rng, n: number) => Array.from({ length: n }, () => "0123456789abcdef"[rng.int(0, 15)]).join("");

export function buildWorld(o: WorldOptions): World {
  const rng = new Rng(o.seed);
  const t0 = dayStart(o.start);
  const ids = Array.from({ length: o.accounts }, (_, i) => `A${10000 + i}`);
  // shuffle ids so roles are not contiguous
  for (let i = ids.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  let next = 0;
  const take = (n: number) => {
    const out = ids.slice(next, next + n);
    next += n;
    return out;
  };
  const scale = o.accounts / 3000;
  const accounts: Account[] = [];
  const tzs = [-8, -6, -5, -5, 0, 1, 1, 2, 3, 8, 9];
  const mk = (id: string, role: Role, group: string | null, extra: Partial<Account> = {}): Account => {
    const nDev = rng.chance(0.14) ? 3 + (rng.chance(0.2) ? 1 : 0) : rng.chance(0.5) ? 2 : 1;
    const a: Account = {
      id,
      role,
      group,
      opened: t0 - rng.int(30, 700) * DAY,
      tz: rng.pick(tzs),
      activeProb: 0.25 + rng.next() * 0.6,
      devices: Array.from({ length: nDev }, () => `dev-${hex(rng, 8)}`),
      homeIp: rng.chance(0.7) ? `10.${rng.int(1, 199)}.${rng.int(0, 255)}.${rng.int(1, 254)}` : null,
      mobileShare: 0.2,
      payout: `addr-${hex(rng, 12)}`,
      office: false,
      onset: 0,
      ...extra,
    };
    if (!a.homeIp) a.mobileShare = 1;
    accounts.push(a);
    return a;
  };

  const marketMakers = take(Math.max(4, Math.round(20 * scale)));
  marketMakers.forEach((id, i) =>
    mk(id, "market_maker", null, {
      opened: t0 - rng.int(900, 1500) * DAY,
      activeProb: 1,
      devices: [`dev-mm-${String(i).padStart(2, "0")}`],
      homeIp: `10.250.0.${i + 1}`,
      mobileShare: 0,
    }),
  );

  const rings: Ring[] = [];
  const nRings = Math.max(4, Math.round(40 * scale));
  const sizes = [2, 2, 3, 3, 3, 4, 4, 5, 6];
  // Bad actors arrive throughout the period rather than all on day one, so every
  // day has something new to find. Accounts are opened a few days before use.
  const onset = () => rng.int(0, Math.max(0, o.days - 3));
  for (let r = 0; r < nRings; r++) {
    const id = `R${String(r + 1).padStart(2, "0")}`;
    const members = take(rng.pick(sizes));
    const ringOnset = onset();
    const ring: Ring = {
      id,
      members,
      mode: rng.chance(0.6) ? "parallel" : "sequential",
      sharedDevice: rng.chance(0.5) ? `dev-${hex(rng, 8)}` : null,
      vpn: rng.chance(0.3),
      trades: rng.chance(0.15) ? "none" : rng.chance(0.5) ? "transfer" : "wash",
      sharedPayout: rng.chance(0.35) ? `addr-${hex(rng, 12)}` : null,
      tz: rng.pick(tzs),
      homeIp: `10.${rng.int(1, 199)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
      onset: ringOnset,
    };
    rings.push(ring);
    for (const m of members) {
      mk(m, "ring", id, {
        onset: ringOnset,
        opened: t0 + (ringOnset - rng.int(2, 30)) * DAY,
        devices: ring.sharedDevice ? [ring.sharedDevice] : [`dev-${hex(rng, 8)}`],
        homeIp: ring.homeIp,
        mobileShare: 0,
        tz: ring.tz,
        payout: ring.sharedPayout ?? `addr-${hex(rng, 12)}`,
      });
    }
  }

  for (const id of take(Math.round(40 * scale))) {
    const on = onset();
    mk(id, "mule", null, { onset: on, opened: t0 + (on - rng.int(1, 20)) * DAY, activeProb: 0.3, devices: [`dev-${hex(rng, 8)}`] });
  }
  for (const id of take(Math.round(25 * scale))) mk(id, "spoofer", null, { activeProb: 0.6, onset: onset() });

  const nHouse = Math.round(50 * scale);
  for (let h = 0; h < nHouse; h++) {
    const group = `H${String(h + 1).padStart(2, "0")}`;
    const laptop = `dev-${hex(rng, 8)}`;
    const ip = `10.${rng.int(1, 199)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
    for (const id of take(2)) mk(id, "household", group, { devices: [laptop], homeIp: ip, mobileShare: 0.1 });
  }

  const rest = ids.slice(next);
  const officeUsers = new Set(rest.slice(0, Math.round(40 * scale)));
  for (const id of rest) mk(id, "normal", null, { office: officeUsers.has(id) });

  return { seed: o.seed, start: o.start, days: o.days, accounts, byId: new Map(accounts.map((a) => [a.id, a])), rings, marketMakers };
}

// ---------------------------------------------------------------- prices

/** One index price per contract per minute for a day, as a geometric random walk. */
export function dayPrices(world: World, dayIndex: number): { ts: number; contract: string; price: number }[] {
  const out: { ts: number; contract: string; price: number }[] = [];
  const t0 = dayStart(world.start) + dayIndex * DAY;
  CONTRACTS.forEach((c, ci) => {
    const rng = new Rng(world.seed * 7919 + ci * 104729 + 1);
    let px = START_PRICE[c];
    // walk from the world's start so every day is reproducible on its own
    for (let m = 0; m < (dayIndex + 1) * 1440; m++) {
      px *= Math.exp(0.0006 * rng.normal());
      if (m >= dayIndex * 1440) out.push({ ts: t0 + (m - dayIndex * 1440) * MINUTE, contract: c, price: px });
    }
  });
  return out.sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------- events

interface DayCtx {
  world: World;
  rng: Rng;
  t0: number;
  out: SimEvent[];
  price: (contract: string, ts: number) => number;
  trade: number;
}

function localHourToTs(ctx: DayCtx, tz: number, hour: number): number {
  return ctx.t0 + ((((hour - tz) % 24) + 24) % 24) * HOUR;
}

function session(ctx: DayCtx, a: Account, start: number, minutes: number, device?: string, ip?: string) {
  const rng = ctx.rng;
  const dev = device ?? (a.office && rng.chance(0.15) ? OFFICE_DEVICE : rng.pick(a.devices));
  const addr = ip ?? (dev === OFFICE_DEVICE ? OFFICE_IP : rng.chance(a.mobileShare) || !a.homeIp ? rng.pick(NAT_IPS) : a.homeIp);
  const id = `s-${hex(rng, 10)}`;
  ctx.out.push({ ts: start, account_id: a.id, kind: "session_start", payload: { device: dev, ip: addr, session: id } });
  ctx.out.push({ ts: start + minutes * MINUTE, account_id: a.id, kind: "session_end", payload: { device: dev, ip: addr, session: id } });
  return { dev, addr, end: start + minutes * MINUTE };
}

function fill(ctx: DayCtx, a: string, b: string, ts: number, contract: string, notional: number, offBps: number) {
  const idx = ctx.price(contract, ts);
  const side = ctx.rng.chance(0.5) ? "buy" : "sell";
  // a buyer paying over the index moves money to the seller, and the reverse
  const price = idx * (1 + ((side === "buy" ? 1 : -1) * offBps) / 1e4);
  const qty = notional / price;
  const trade = `t-${ctx.trade++}`;
  const common = { contract, qty, price, notional, trade_id: trade };
  ctx.out.push({ ts, account_id: a, kind: "fill", payload: { ...common, side, counterparty: b } });
  ctx.out.push({ ts, account_id: b, kind: "fill", payload: { ...common, side: side === "buy" ? "sell" : "buy", counterparty: a } });
}

function normalTrading(ctx: DayCtx, a: Account, start: number, end: number, ordersMean: number) {
  const rng = ctx.rng;
  const n = rng.poisson(ordersMean);
  for (let i = 0; i < n; i++) {
    const ts = start + rng.next() * (end - start);
    const contract = rng.pick(CONTRACTS);
    ctx.out.push({ ts, account_id: a.id, kind: "order", payload: { contract } });
    const u = rng.next();
    if (u < 0.45) {
      const cp = rng.chance(0.9) ? rng.pick(ctx.world.marketMakers) : rng.pick(ctx.world.accounts).id;
      if (cp !== a.id) fill(ctx, a.id, cp, ts + rng.int(1, 20) * 1000, contract, Math.exp(7.2 + 0.9 * rng.normal()), Math.abs(rng.normal()) * 2);
    } else if (u < 0.85) {
      ctx.out.push({ ts: ts + rng.int(5, 120) * 1000, account_id: a.id, kind: "cancel", payload: { contract } });
    }
  }
}

function money(ctx: DayCtx, a: Account, start: number, end: number) {
  const rng = ctx.rng;
  if (rng.chance(0.08)) {
    const amt = Math.round(Math.exp(7.8 + 0.8 * rng.normal()));
    ctx.out.push({ ts: start + 30_000, account_id: a.id, kind: "deposit", payload: { amount: amt } });
  }
  if (rng.chance(0.05)) {
    const amt = Math.round(Math.exp(7.2 + 0.8 * rng.normal()));
    ctx.out.push({ ts: end - 30_000, account_id: a.id, kind: "withdrawal", payload: { amount: amt, address: a.payout } });
  }
}

function genNormal(ctx: DayCtx, a: Account) {
  const rng = ctx.rng;
  if (!rng.chance(a.activeProb)) return;
  const sessions = 1 + rng.poisson(0.4);
  for (let s = 0; s < sessions; s++) {
    const hour = 7 + rng.next() * 16;
    const start = localHourToTs(ctx, a.tz, hour);
    const { end } = session(ctx, a, start, rng.int(8, 75));
    normalTrading(ctx, a, start, end, 4);
    money(ctx, a, start, end);
  }
}

function genMarketMaker(ctx: DayCtx, a: Account) {
  const rng = ctx.rng;
  const { end } = session(ctx, a, ctx.t0 + 5_000, 1438);
  let t = ctx.t0 + 60_000;
  while (t < end - 60_000) {
    const contract = rng.pick(CONTRACTS);
    ctx.out.push({ ts: t, account_id: a.id, kind: "order", payload: { contract } });
    ctx.out.push({ ts: t + rng.int(2, 50) * 1000, account_id: a.id, kind: "cancel", payload: { contract } });
    if (rng.chance(0.05)) {
      const other = rng.pick(ctx.world.marketMakers);
      if (other !== a.id) fill(ctx, a.id, other, t + 1000, contract, Math.exp(9 + 0.6 * rng.normal()), Math.abs(rng.normal()));
    }
    t += rng.int(2, 7) * MINUTE;
  }
}

function genRing(ctx: DayCtx, ring: Ring, dayIndex: number) {
  const rng = ctx.rng;
  if (dayIndex < ring.onset) return;
  const accts = ring.members.map((m) => ctx.world.byId.get(m)!);
  if (!rng.chance(0.7)) return;
  const sessions = 1 + rng.poisson(0.8);
  for (let s = 0; s < sessions; s++) {
    let t = localHourToTs(ctx, ring.tz, 9 + rng.next() * 13);
    const ip = () => (ring.vpn ? `198.18.${rng.int(0, 255)}.${rng.int(1, 254)}` : ring.homeIp);
    const windows: { a: Account; start: number; end: number }[] = [];
    if (ring.mode === "parallel") {
      const len = rng.int(20, 45);
      for (const a of accts) {
        const st = t + rng.int(0, 150) * 1000;
        session(ctx, a, st, len, ring.sharedDevice ?? a.devices[0], ip());
        windows.push({ a, start: st, end: st + len * MINUTE });
      }
      // the operator works the accounts side by side: same minutes, seconds apart
      const bursts = rng.int(6, 14);
      for (let k = 0; k < bursts; k++) {
        const bt = t + (3 + rng.next() * (len - 6)) * MINUTE;
        for (const a of accts) {
          if (rng.chance(0.85)) ctx.out.push({ ts: bt + rng.int(0, 40) * 1000, account_id: a.id, kind: "order", payload: { contract: rng.pick(CONTRACTS) } });
        }
      }
    } else {
      // one account after another on the same machine or network
      for (const a of accts) {
        const len = rng.int(8, 20);
        session(ctx, a, t, len, ring.sharedDevice ?? a.devices[0], ip());
        windows.push({ a, start: t, end: t + len * MINUTE });
        normalTrading(ctx, a, t, t + len * MINUTE, 3);
        t += len * MINUTE + rng.int(25, 100) * 1000;
      }
    }
    if (ring.trades !== "none") {
      const n = rng.int(3, 7);
      for (let k = 0; k < n; k++) {
        const w = rng.pick(windows);
        const others = accts.filter((x) => x.id !== w.a.id);
        const cp = rng.pick(others);
        const ts = w.start + rng.next() * (w.end - w.start);
        const off = ring.trades === "transfer" ? 100 + rng.next() * 200 : Math.abs(rng.normal()) * 3;
        fill(ctx, w.a.id, cp.id, ts, rng.pick(CONTRACTS), 4000 + rng.next() * 16000, off);
      }
    }
    for (const w of windows) {
      if (rng.chance(0.25)) {
        ctx.out.push({ ts: w.start + 60_000, account_id: w.a.id, kind: "deposit", payload: { amount: rng.int(2000, 15000) } });
      }
      if (rng.chance(0.2)) {
        ctx.out.push({ ts: w.end - 60_000, account_id: w.a.id, kind: "withdrawal", payload: { amount: rng.int(1000, 12000), address: w.a.payout } });
      }
    }
  }
}

function genMule(ctx: DayCtx, a: Account) {
  const rng = ctx.rng;
  if (!rng.chance(a.activeProb)) return;
  const start = localHourToTs(ctx, a.tz, 8 + rng.next() * 14);
  const stay = rng.int(25, 85);
  session(ctx, a, start, stay + 2);
  const amt = rng.int(2000, 10000);
  ctx.out.push({ ts: start + 60_000, account_id: a.id, kind: "deposit", payload: { amount: amt } });
  if (rng.chance(0.6)) normalTrading(ctx, a, start + 2 * MINUTE, start + stay * MINUTE, 1);
  ctx.out.push({
    ts: start + stay * MINUTE,
    account_id: a.id,
    kind: "withdrawal",
    payload: { amount: Math.round(amt * (0.85 + rng.next() * 0.15)), address: `addr-${hex(rng, 12)}` },
  });
}

function genSpoofer(ctx: DayCtx, a: Account) {
  const rng = ctx.rng;
  if (!rng.chance(a.activeProb)) return;
  const sessions = 1 + rng.poisson(0.5);
  for (let s = 0; s < sessions; s++) {
    const start = localHourToTs(ctx, a.tz, 8 + rng.next() * 14);
    const len = rng.int(25, 50);
    session(ctx, a, start, len);
    const n = rng.int(40, 90);
    for (let i = 0; i < n; i++) {
      const ts = start + rng.next() * len * MINUTE;
      const contract = rng.pick(CONTRACTS);
      ctx.out.push({ ts, account_id: a.id, kind: "order", payload: { contract } });
      if (rng.chance(0.95)) ctx.out.push({ ts: ts + rng.int(1, 6) * 1000, account_id: a.id, kind: "cancel", payload: { contract } });
      else fill(ctx, a.id, rng.pick(ctx.world.marketMakers), ts + 1000, contract, Math.exp(7 + 0.5 * rng.normal()), 1);
    }
  }
}

/** Market-wide bursts: a few minutes a day when hundreds of accounts act at once. */
function genBursts(ctx: DayCtx) {
  const rng = ctx.rng;
  const normals = ctx.world.accounts.filter((a) => a.role === "normal");
  for (let b = 0; b < 2; b++) {
    const minute = ctx.t0 + rng.int(60, 1380) * MINUTE;
    for (let m = 0; m < 3; m++) {
      const n = rng.int(250, 400);
      for (let i = 0; i < n; i++) {
        const a = rng.pick(normals);
        ctx.out.push({ ts: minute + m * MINUTE + rng.int(0, 59) * 1000, account_id: a.id, kind: "order", payload: { contract: CONTRACTS[0] } });
      }
    }
  }
}

/** All events for one day, sorted. Deterministic for (world seed, day index). */
export function dayEvents(world: World, dayIndex: number, prices: { ts: number; contract: string; price: number }[]): SimEvent[] {
  const byContract = new Map<string, { ts: number[]; px: number[] }>();
  for (const p of prices) {
    if (!byContract.has(p.contract)) byContract.set(p.contract, { ts: [], px: [] });
    byContract.get(p.contract)!.ts.push(p.ts);
    byContract.get(p.contract)!.px.push(p.price);
  }
  const price = (c: string, ts: number) => {
    const s = byContract.get(c)!;
    let lo = 0;
    let hi = s.ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s.ts[mid] <= ts) lo = mid;
      else hi = mid - 1;
    }
    return s.px[lo];
  };
  const ctx: DayCtx = { world, rng: new Rng(world.seed * 31 + dayIndex * 1009 + 17), t0: dayStart(world.start) + dayIndex * DAY, out: [], price, trade: dayIndex * 10_000_000 };
  for (const a of world.accounts) {
    if (a.role === "normal" || a.role === "household") genNormal(ctx, a);
    else if (a.role === "market_maker") genMarketMaker(ctx, a);
    else if (a.role === "mule" && dayIndex >= a.onset) genMule(ctx, a);
    else if (a.role === "spoofer" && dayIndex >= a.onset) genSpoofer(ctx, a);
  }
  for (const r of world.rings) genRing(ctx, r, dayIndex);
  genBursts(ctx);
  const end = ctx.t0 + DAY;
  // keep the day self-contained: a session that would run past midnight is clipped
  // stable sort: at equal timestamps, events keep the order they were generated in
  return ctx.out.filter((e) => e.ts >= ctx.t0 && e.ts < end).sort((a, b) => a.ts - b.ts);
}
