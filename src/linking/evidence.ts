import type { LinkingConfig } from "../config.js";
import type { Db, Tx } from "../db.js";
import type { EngineEvent } from "../engine/state.js";
import { pairKey } from "../util.js";

/**
 * Link evidence that can be updated per event, inside the consumer:
 *  - identifiers seen per account (device, IP, payout address)
 *  - IP coincidence: two accounts start sessions on one IP within 10 minutes
 *  - session handoffs: one account ends a session and another starts on the
 *    same device or IP within two minutes
 *  - fills between the two accounts, with how far off the index they printed
 * Shared-minute co-activity is a batch job (models/surveil_models/coactivity.py).
 */
export interface PairRow {
  a: string;
  b: string;
  kind: "ip_coincident" | "handoff" | "pair_fills";
  value: number;
  detail: Record<string, any>;
}

interface Seen {
  account: string;
  ts: number;
}

export class EvidenceTracker {
  private pairs = new Map<string, PairRow>();
  private dirtyPairs = new Set<string>();
  private idents = new Map<string, { kind: string; value: string; account: string; first: number; last: number }>();
  private recentStarts = new Map<string, Seen[]>();
  private recentEnds = new Map<string, Seen[]>();

  constructor(private cfg: LinkingConfig) {}

  async load(db: Db): Promise<void> {
    const r = await db.query("SELECT a, b, kind, value, detail FROM pair_evidence WHERE kind IN ('ip_coincident','handoff','pair_fills')");
    for (const row of r.rows) this.pairs.set(`${row.a}|${row.b}|${row.kind}`, { ...row, value: Number(row.value) });
  }

  /**
   * After a restart, rebuild the recent-session windows from the stream itself,
   * so a coincidence or handoff that straddles the restart is still counted.
   * Only the windows are rebuilt; the counts were committed with the cursor.
   */
  async warm(db: Db, lastEventId: number, eventTime: number): Promise<void> {
    const win = Math.max(this.cfg.ip_coincidence_seconds, this.cfg.handoff_seconds) * 1000;
    const r = await db.query(
      `SELECT ts, account_id, kind, payload FROM events
       WHERE id <= $1 AND ts > $2 AND kind IN ('session_start','session_end') ORDER BY id`,
      [lastEventId, new Date(eventTime - win)],
    );
    for (const row of r.rows) {
      const ts = new Date(row.ts).getTime();
      const p = row.payload;
      if (row.kind === "session_start") {
        this.recent(this.recentStarts, String(p.ip), ts, this.cfg.ip_coincidence_seconds * 1000).push({ account: row.account_id, ts });
      } else {
        const hw = this.cfg.handoff_seconds * 1000;
        this.recent(this.recentEnds, `d:${p.device}`, ts, hw).push({ account: row.account_id, ts });
        this.recent(this.recentEnds, `i:${p.ip}`, ts, hw).push({ account: row.account_id, ts });
      }
    }
  }

  get(a: string, b: string, kind: PairRow["kind"]): PairRow | undefined {
    const [x, y] = pairKey(a, b);
    return this.pairs.get(`${x}|${y}|${kind}`);
  }

  private bump(a: string, b: string, kind: PairRow["kind"], fn: (r: PairRow) => void): void {
    const [x, y] = pairKey(a, b);
    const key = `${x}|${y}|${kind}`;
    let row = this.pairs.get(key);
    if (!row) {
      row = { a: x, b: y, kind, value: 0, detail: {} };
      this.pairs.set(key, row);
    }
    fn(row);
    this.dirtyPairs.add(key);
  }

  private ident(kind: string, value: string, account: string, ts: number): void {
    const key = `${kind}|${value}|${account}`;
    const cur = this.idents.get(key);
    if (cur) cur.last = Math.max(cur.last, ts);
    else this.idents.set(key, { kind, value, account, first: ts, last: ts });
  }

  private recent(map: Map<string, Seen[]>, key: string, now: number, windowMs: number): Seen[] {
    const list = (map.get(key) ?? []).filter((s) => now - s.ts <= windowMs);
    map.set(key, list);
    return list;
  }

  onEvent(ev: EngineEvent, indexAt: (contract: string, ts: number) => number | null): void {
    const p = ev.payload;
    if (ev.kind === "session_start") {
      const device = String(p.device);
      const ip = String(p.ip);
      this.ident("device", device, ev.account_id, ev.ts);
      this.ident("ip", ip, ev.account_id, ev.ts);
      // IP coincidence
      const starts = this.recent(this.recentStarts, ip, ev.ts, this.cfg.ip_coincidence_seconds * 1000);
      const counted = new Set<string>();
      for (const s of starts) {
        if (s.account === ev.account_id || counted.has(s.account)) continue;
        counted.add(s.account);
        this.bump(ev.account_id, s.account, "ip_coincident", (r) => {
          r.value += 1;
          r.detail.ips = r.detail.ips ?? {};
          r.detail.ips[ip] = (r.detail.ips[ip] ?? 0) + 1;
        });
      }
      starts.push({ account: ev.account_id, ts: ev.ts });
      // Handoff: prefer the device match, fall back to the IP
      const win = this.cfg.handoff_seconds * 1000;
      const byDevice = this.recent(this.recentEnds, `d:${device}`, ev.ts, win).filter((s) => s.account !== ev.account_id);
      const byIp = this.recent(this.recentEnds, `i:${ip}`, ev.ts, win).filter((s) => s.account !== ev.account_id);
      const hit = byDevice.length ? { s: byDevice[byDevice.length - 1], via: "device" } : byIp.length ? { s: byIp[byIp.length - 1], via: "ip" } : null;
      if (hit) {
        this.bump(ev.account_id, hit.s.account, "handoff", (r) => {
          r.value += 1;
          r.detail.device = (r.detail.device ?? 0) + (hit.via === "device" ? 1 : 0);
          r.detail.ips = r.detail.ips ?? {};
          if (hit.via === "ip") r.detail.ips[ip] = (r.detail.ips[ip] ?? 0) + 1;
        });
      }
    } else if (ev.kind === "session_end") {
      const now = ev.ts;
      const win = this.cfg.handoff_seconds * 1000;
      this.recent(this.recentEnds, `d:${p.device}`, now, win).push({ account: ev.account_id, ts: now });
      this.recent(this.recentEnds, `i:${p.ip}`, now, win).push({ account: ev.account_id, ts: now });
    } else if (ev.kind === "withdrawal" && p.address) {
      this.ident("payout", String(p.address), ev.account_id, ev.ts);
    } else if (ev.kind === "fill") {
      const cp = String(p.counterparty);
      // Each trade arrives once per side; count it on the side with the smaller id.
      if (ev.account_id < cp) {
        const idx = indexAt(p.contract, ev.ts);
        const dev = idx ? Math.abs(Number(p.price) / idx - 1) * 1e4 : 0;
        const n = Number(p.notional);
        this.bump(ev.account_id, cp, "pair_fills", (r) => {
          r.value += 1;
          r.detail.notional = (r.detail.notional ?? 0) + n;
          r.detail.dev_notional = (r.detail.dev_notional ?? 0) + n * dev;
        });
      }
    }
  }

  /** Bound memory for the recent-session indexes. */
  trim(now: number): void {
    const win = Math.max(this.cfg.ip_coincidence_seconds, this.cfg.handoff_seconds) * 1000;
    for (const map of [this.recentStarts, this.recentEnds]) {
      for (const [k, list] of map) {
        const keep = list.filter((s) => now - s.ts <= win);
        if (keep.length) map.set(k, keep);
        else map.delete(k);
      }
    }
  }

  async flush(tx: Tx, at: Date): Promise<void> {
    if (this.dirtyPairs.size) {
      const rows = [...this.dirtyPairs].map((k) => this.pairs.get(k)!);
      await tx.query(
        `INSERT INTO pair_evidence (a, b, kind, value, detail, updated_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::jsonb[], $6::timestamptz[])
         ON CONFLICT (a, b, kind) DO UPDATE SET value = EXCLUDED.value, detail = EXCLUDED.detail, updated_at = EXCLUDED.updated_at`,
        [rows.map((r) => r.a), rows.map((r) => r.b), rows.map((r) => r.kind), rows.map((r) => r.value),
          rows.map((r) => JSON.stringify(r.detail)), rows.map(() => at)],
      );
      this.dirtyPairs.clear();
    }
    if (this.idents.size) {
      const rows = [...this.idents.values()];
      await tx.query(
        `INSERT INTO identifiers (kind, value, account_id, first_seen, last_seen)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[])
         ON CONFLICT (kind, value, account_id) DO UPDATE
           SET first_seen = LEAST(identifiers.first_seen, EXCLUDED.first_seen),
               last_seen = GREATEST(identifiers.last_seen, EXCLUDED.last_seen)`,
        [rows.map((r) => r.kind), rows.map((r) => r.value), rows.map((r) => r.account),
          rows.map((r) => new Date(r.first)), rows.map((r) => new Date(r.last))],
      );
      this.idents.clear();
    }
  }
}
