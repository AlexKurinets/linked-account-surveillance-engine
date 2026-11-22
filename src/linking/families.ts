import type { LinkingConfig } from "../config.js";

/**
 * Everything known about one pair of accounts, gathered from the identifiers
 * table, the consumer's pair evidence and the co-activity batch.
 */
export interface PairEvidence {
  a: string;
  b: string;
  shared: { kind: "device" | "payout"; value: string; k: number }[];
  ipCoincident?: { count: number; ips: Record<string, number> };
  handoff?: { count: number; device: number; ips: Record<string, number> };
  coactivity?: { surprise: number; cut: number; shared_minutes: number; expected: number };
  pairFills?: { count: number; notional: number; dev_notional: number };
}

export interface FamilyScores {
  identity: number;
  timing: number;
  money: number;
  families: ("identity" | "timing" | "money")[];
  total: number;
  linked: boolean;
}

/**
 * Weight of an identifier shared by k of N accounts: log(N / k), the same idea
 * as inverse document frequency. Two accounts on one laptop is strong; four
 * hundred phones behind one carrier NAT address is close to nothing, and past
 * the cap it counts for nothing at all.
 */
export function identifierWeight(k: number, n: number, cfg: LinkingConfig): number {
  if (!cfg.rarity_weighting) return Math.log(n / 2);
  if (k > cfg.identifier_cap) return 0;
  return Math.log(n / Math.max(k, 2));
}

export function scoreFamilies(e: PairEvidence, n: number, ipPopularity: (ip: string) => number, cfg: LinkingConfig): FamilyScores {
  // Identity: shared devices and payout addresses; IPs only when two sessions start on one within 10 minutes.
  let identity = 0;
  for (const s of e.shared) identity += identifierWeight(s.k, n, cfg);
  if (e.ipCoincident) {
    for (const [ip, count] of Object.entries(e.ipCoincident.ips)) {
      identity += 0.5 * identifierWeight(ipPopularity(ip), n, cfg) * (1 - Math.exp(-count / 2));
    }
  }
  identity = Math.min(identity, 12);

  // Timing: shared active minutes beyond chance, and repeated session handoffs.
  let timing = 0;
  if (e.coactivity && e.coactivity.surprise >= e.coactivity.cut) {
    timing += Math.min(6, 1.5 + (e.coactivity.surprise - e.coactivity.cut) / 3);
  }
  if (e.handoff) {
    let usable = e.handoff.device;
    for (const [ip, c] of Object.entries(e.handoff.ips ?? {})) if (identifierWeight(ipPopularity(ip), n, cfg) > 0) usable += c;
    if (usable >= cfg.handoff_min_count) timing += Math.log2(1 + usable);
  }
  timing = Math.min(timing, 8);

  // Money: fills between the pair, weighted up when they print far from the index.
  let money = 0;
  if (e.pairFills && e.pairFills.count >= cfg.pair_fill_min_count) {
    const avgDev = e.pairFills.notional > 0 ? e.pairFills.dev_notional / e.pairFills.notional : 0;
    money = Math.min(8, Math.log2(1 + e.pairFills.count) * (1 + Math.min(2, avgDev / 100)));
  }

  const families = (["identity", "timing", "money"] as const).filter(
    (f) => ({ identity, timing, money })[f] >= cfg.family_min_score,
  );
  const total = identity + timing + money;
  const enough = cfg.require_two_families ? families.length >= 2 : families.length >= 1;
  return { identity, timing, money, families: [...families], total, linked: enough && total >= cfg.link_threshold };
}

/** A short, human-readable account of why two accounts were linked. */
export function describeEvidence(e: PairEvidence, s: FamilyScores): Record<string, unknown> {
  const out: Record<string, unknown> = { families: s.families, score: Math.round(s.total * 100) / 100 };
  if (e.shared.length) out.shared_identifiers = e.shared.map((x) => `${x.kind} ${x.value} (${x.k} accounts)`);
  if (e.ipCoincident) out.ip_coincidences = e.ipCoincident.count;
  if (e.handoff) out.handoffs = e.handoff.count;
  if (e.coactivity) {
    out.shared_minutes = e.coactivity.shared_minutes;
    out.expected_shared_minutes = Math.round(e.coactivity.expected * 100) / 100;
  }
  if (e.pairFills) {
    out.pair_fills = e.pairFills.count;
    out.avg_off_index_bps = e.pairFills.notional > 0 ? Math.round(e.pairFills.dev_notional / e.pairFills.notional) : 0;
  }
  return out;
}
