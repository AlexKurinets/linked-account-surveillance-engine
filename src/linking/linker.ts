import type { LinkingConfig } from "../config.js";
import { type Db, setConfigValue, withTx } from "../db.js";
import { DAY } from "../util.js";
import { clusterLinks, type Clustering } from "./cluster.js";
import { describeEvidence, type FamilyScores, type PairEvidence, scoreFamilies } from "./families.js";

export interface EvidenceSet {
  n: number;
  pairs: PairEvidence[];
  ipPopularity: Map<string, number>;
}

export async function loadEvidence(db: Db, asOf: Date): Promise<EvidenceSet> {
  const n = Math.max(2, Number((await db.query("SELECT count(*) AS n FROM account_state")).rows[0].n));
  const byPair = new Map<string, PairEvidence>();
  const get = (a: string, b: string) => {
    const key = `${a}|${b}`;
    let e = byPair.get(key);
    if (!e) {
      e = { a, b, shared: [] };
      byPair.set(key, e);
    }
    return e;
  };
  // Shared devices and payout addresses. Identifiers shared by more than 200
  // accounts are never evidence of anything and would only blow up the join.
  const shared = await db.query(
    `WITH g AS (
       SELECT kind, value, count(*) AS k FROM identifiers
       WHERE kind IN ('device','payout') GROUP BY kind, value HAVING count(*) BETWEEN 2 AND 200)
     SELECT i1.account_id AS a, i2.account_id AS b, g.kind, g.value, g.k
     FROM g
     JOIN identifiers i1 ON i1.kind = g.kind AND i1.value = g.value
     JOIN identifiers i2 ON i2.kind = g.kind AND i2.value = g.value AND i1.account_id < i2.account_id`,
  );
  for (const r of shared.rows) get(r.a, r.b).shared.push({ kind: r.kind, value: r.value, k: Number(r.k) });

  const ips = await db.query(
    `SELECT value, count(*) AS k FROM identifiers WHERE kind = 'ip' AND last_seen >= $1 GROUP BY value`,
    [new Date(asOf.getTime() - 7 * DAY)],
  );
  const ipPopularity = new Map<string, number>(ips.rows.map((r) => [r.value, Number(r.k)]));

  const ev = await db.query("SELECT a, b, kind, value, detail FROM pair_evidence");
  for (const r of ev.rows) {
    const e = get(r.a, r.b);
    const d = r.detail ?? {};
    if (r.kind === "ip_coincident") e.ipCoincident = { count: Number(r.value), ips: d.ips ?? {} };
    else if (r.kind === "handoff") e.handoff = { count: Number(r.value), device: d.device ?? 0, ips: d.ips ?? {} };
    else if (r.kind === "pair_fills") e.pairFills = { count: Number(r.value), notional: d.notional ?? 0, dev_notional: d.dev_notional ?? 0 };
    else if (r.kind === "coactivity")
      e.coactivity = { surprise: Number(r.value), cut: d.cut, shared_minutes: d.shared_minutes, expected: d.expected };
  }
  return { n, pairs: [...byPair.values()], ipPopularity };
}

export interface LinkResult {
  scored: { e: PairEvidence; s: FamilyScores }[];
  clustering: Clustering;
}

export function computeLinks(ev: EvidenceSet, cfg: LinkingConfig): LinkResult {
  const pop = (ip: string) => ev.ipPopularity.get(ip) ?? 1;
  const scored = ev.pairs.map((e) => ({ e, s: scoreFamilies(e, ev.n, pop, cfg) })).filter((x) => x.s.linked);
  const clustering = clusterLinks(scored.map((x) => ({ a: x.e.a, b: x.e.b, score: x.s.total })), cfg.max_cluster_size);
  return { scored, clustering };
}

/** One linking pass: score every pair with evidence, cluster, and replace the published clusters. */
export async function runLinker(db: Db, asOf: Date, cfg: LinkingConfig) {
  const ev = await loadEvidence(db, asOf);
  const { scored, clustering } = computeLinks(ev, cfg);
  const applied = new Set(clustering.applied.map((l) => `${l.a}|${l.b}`));
  await withTx(db, async (tx) => {
    await tx.query("DELETE FROM links");
    const rows = scored.filter((x) => applied.has(`${x.e.a}|${x.e.b}`));
    if (rows.length) {
      await tx.query(
        `INSERT INTO links (a, b, score, families, evidence)
         SELECT a, b, s, string_to_array(f, ','), ev FROM unnest($1::text[], $2::text[], $3::float8[], $4::text[], $5::jsonb[]) AS t(a, b, s, f, ev)`,
        [rows.map((x) => x.e.a), rows.map((x) => x.e.b), rows.map((x) => x.s.total),
          rows.map((x) => x.s.families.join(",")), rows.map((x) => JSON.stringify(describeEvidence(x.e, x.s)))],
      );
    }
    const ids = [...clustering.clusters.keys()];
    await tx.query("DELETE FROM clusters WHERE NOT (cluster_id = ANY($1::text[]))", [ids]);
    for (const [id, members] of clustering.clusters) {
      const minScore = Math.min(...clustering.applied.filter((l) => members.includes(l.a)).map((l) => l.score));
      await tx.query(
        `INSERT INTO clusters (cluster_id, members, min_link_score, first_seen, updated_at) VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (cluster_id) DO UPDATE SET members = EXCLUDED.members, min_link_score = EXCLUDED.min_link_score, updated_at = EXCLUDED.updated_at`,
        [id, members, minScore, asOf],
      );
    }
    await tx.query("DELETE FROM account_cluster");
    const pairs = [...clustering.clusters].flatMap(([id, ms]) => ms.map((m) => [m, id]));
    if (pairs.length) {
      await tx.query("INSERT INTO account_cluster SELECT * FROM unnest($1::text[], $2::text[])", [pairs.map((p) => p[0]), pairs.map((p) => p[1])]);
    }
    for (const l of clustering.refused) {
      await tx.query(
        `INSERT INTO link_reviews (a, b, score, reason, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (a, b) DO UPDATE SET score = EXCLUDED.score`,
        [l.a, l.b, l.score, `merge would exceed ${cfg.max_cluster_size} accounts`, asOf],
      );
    }
    await setConfigValue(tx, "clusters_version", { at: asOf.toISOString(), clusters: ids.length }, asOf);
  });
  return { links: clustering.applied.length, clusters: clustering.clusters.size, refused: clustering.refused.length };
}
