import type { EngineConfig } from "../config.js";
import { DAY, HOUR, MINUTE } from "../util.js";

/**
 * Per-account state built from exponentially decayed counters. Each event costs
 * one O(1) update instead of a scan over a time window: a counter c last
 * touched at t is worth c * 2^(-(now - t) / half_life) at time now.
 *
 * "_s" counters use the short half-life (60 minutes), "_l" the long one (24 h).
 */
export interface AccountState {
  opened: number;
  t: number;
  orders_s: number;
  cancels_s: number;
  notional_l: number;
  dev_notional_l: number;
  cluster_notional_l: number;
  deposits_l: number;
  withdrawals_l: number;
  /** decayed fill notional per counterparty (long half-life), largest 50 kept */
  cp: Record<string, number>;
  devices: Record<string, number>;
  ips: Record<string, number>;
  last_deposit: number | null;
  last_withdrawal: number | null;
  in_out_minutes: number | null;
}

export interface EngineEvent {
  id: number;
  ts: number;
  account_id: string;
  kind: "session_start" | "session_end" | "order" | "cancel" | "fill" | "deposit" | "withdrawal";
  payload: Record<string, any>;
}

export interface StateContext {
  indexPrice(contract: string, ts: number): number | null;
  clusterOf(accountId: string): string | null;
}

export type Features = Record<string, number>;

export function newState(opened: number, t: number): AccountState {
  return {
    opened,
    t,
    orders_s: 0,
    cancels_s: 0,
    notional_l: 0,
    dev_notional_l: 0,
    cluster_notional_l: 0,
    deposits_l: 0,
    withdrawals_l: 0,
    cp: {},
    devices: {},
    ips: {},
    last_deposit: null,
    last_withdrawal: null,
    in_out_minutes: null,
  };
}

export function decayFactor(dtMs: number, halfLifeMinutes: number): number {
  return dtMs <= 0 ? 1 : Math.pow(2, -dtMs / (halfLifeMinutes * MINUTE));
}

/** Decay every counter forward to `to`. Mutates. Events slightly out of order are treated as simultaneous. */
export function decayTo(s: AccountState, to: number, cfg: EngineConfig["state"]): void {
  const dt = to - s.t;
  if (dt <= 0) return;
  const fs = decayFactor(dt, cfg.short_half_life_minutes);
  const fl = decayFactor(dt, cfg.long_half_life_minutes);
  s.orders_s *= fs;
  s.cancels_s *= fs;
  s.notional_l *= fl;
  s.dev_notional_l *= fl;
  s.cluster_notional_l *= fl;
  s.deposits_l *= fl;
  s.withdrawals_l *= fl;
  for (const k of Object.keys(s.cp)) s.cp[k] *= fl;
  s.t = to;
}

export function applyEvent(s: AccountState, ev: EngineEvent, ctx: StateContext, cfg: EngineConfig["state"]): void {
  decayTo(s, ev.ts, cfg);
  const p = ev.payload;
  switch (ev.kind) {
    case "order":
      s.orders_s += 1;
      break;
    case "cancel":
      s.cancels_s += 1;
      break;
    case "fill": {
      const notional = Number(p.notional);
      s.notional_l += notional;
      const idx = ctx.indexPrice(p.contract, ev.ts);
      if (idx && idx > 0) s.dev_notional_l += notional * Math.abs(Number(p.price) / idx - 1) * 1e4;
      const cp = String(p.counterparty);
      s.cp[cp] = (s.cp[cp] ?? 0) + notional;
      const mine = ctx.clusterOf(ev.account_id);
      if (mine !== null && mine === ctx.clusterOf(cp)) s.cluster_notional_l += notional;
      break;
    }
    case "session_start":
      s.devices[String(p.device)] = ev.ts;
      s.ips[String(p.ip)] = ev.ts;
      break;
    case "session_end":
      break;
    case "deposit":
      s.deposits_l += Number(p.amount);
      s.last_deposit = ev.ts;
      break;
    case "withdrawal":
      s.withdrawals_l += Number(p.amount);
      s.last_withdrawal = ev.ts;
      s.in_out_minutes = s.last_deposit !== null ? (ev.ts - s.last_deposit) / MINUTE : null;
      break;
  }
  prune(s, ev.ts, cfg);
}

function prune(s: AccountState, now: number, cfg: EngineConfig["state"]): void {
  const devCut = now - cfg.device_window_days * DAY;
  for (const [k, t] of Object.entries(s.devices)) if (t < devCut) delete s.devices[k];
  const ipCut = now - cfg.ip_window_hours * HOUR;
  for (const [k, t] of Object.entries(s.ips)) if (t < ipCut) delete s.ips[k];
  const entries = Object.entries(s.cp);
  if (entries.length > 60) {
    entries.sort((a, b) => b[1] - a[1]);
    s.cp = Object.fromEntries(entries.slice(0, 50).filter(([, v]) => v >= 1));
  }
}

/** Read features at time `now` without mutating the stored state. */
export function features(s: AccountState, now: number, cfg: EngineConfig["state"]): Features {
  const dt = Math.max(0, now - s.t);
  const fs = decayFactor(dt, cfg.short_half_life_minutes);
  const fl = decayFactor(dt, cfg.long_half_life_minutes);
  const orders = s.orders_s * fs;
  const cancels = s.cancels_s * fs;
  const notional = s.notional_l * fl;
  const deposits = s.deposits_l * fl;
  const withdrawals = s.withdrawals_l * fl;
  let topCp = 0;
  for (const v of Object.values(s.cp)) topCp = Math.max(topCp, v * fl);
  const devCut = now - cfg.device_window_days * DAY;
  const ipCut = now - cfg.ip_window_hours * HOUR;
  const age = Math.max(0, (now - s.opened) / DAY);
  const recentWithdrawal = s.last_withdrawal !== null && now - s.last_withdrawal <= DAY;
  const f: Features = {
    orders_1h: orders,
    cancel_ratio_1h: orders >= 0.5 ? Math.min(1, cancels / orders) : 0,
    fill_notional_24h: notional,
    off_index_bps_24h: notional > 1 ? (s.dev_notional_l * fl) / notional : 0,
    top_counterparty_share_24h: notional > 1 ? Math.min(1, topCp / notional) : 0,
    cluster_fill_share_24h: notional > 1 ? Math.min(1, (s.cluster_notional_l * fl) / notional) : 0,
    withdraw_ratio_24h: deposits > 1 ? Math.min(5, withdrawals / deposits) : withdrawals > 1 ? 5 : 0,
    in_out_minutes: recentWithdrawal && s.in_out_minutes !== null ? s.in_out_minutes : 1440,
    devices_7d: Object.values(s.devices).filter((t) => t >= devCut).length,
    ips_24h: Object.values(s.ips).filter((t) => t >= ipCut).length,
    account_age_days: age,
  };
  f.log_orders_1h = Math.log1p(f.orders_1h);
  f.log_fill_notional_24h = Math.log1p(f.fill_notional_24h);
  f.log_account_age_days = Math.log1p(age);
  return f;
}
