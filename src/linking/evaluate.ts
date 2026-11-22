import type { LinkingConfig } from "../config.js";
import type { Db } from "../db.js";
import { computeLinks, type EvidenceSet } from "./linker.js";

/**
 * Pairwise evaluation against the synthetic ground truth: two accounts form a
 * true pair when one person runs both. Households sharing a laptop and market
 * makers trading with each other are different people, so linking them counts
 * as a false positive. In production the same numbers came from pairs the
 * analysts had labelled.
 */
export interface LinkEvaluation {
  true_pairs: number;
  predicted_pairs: number;
  correct_pairs: number;
  precision: number | null;
  recall: number | null;
  clusters: number;
  largest_cluster: number;
  household_pairs_linked: number;
  market_maker_pairs_linked: number;
}

export interface Truth {
  role: Map<string, string>;
  group: Map<string, string>;
}

export async function loadTruth(db: Db): Promise<Truth> {
  const r = await db.query("SELECT account_id, role, group_id FROM sim_truth");
  return {
    role: new Map(r.rows.map((x) => [x.account_id, x.role])),
    group: new Map(r.rows.filter((x) => x.group_id).map((x) => [x.account_id, x.group_id])),
  };
}

function pairsOf(groups: Iterable<string[]>): Set<string> {
  const out = new Set<string>();
  for (const ms of groups) {
    const s = [...ms].sort();
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) out.add(`${s[i]}|${s[j]}`);
  }
  return out;
}

export function evaluateClusters(clusters: Map<string, string[]>, truth: Truth): LinkEvaluation {
  const rings = new Map<string, string[]>();
  for (const [acct, g] of truth.group) {
    if (truth.role.get(acct) !== "ring") continue;
    if (!rings.has(g)) rings.set(g, []);
    rings.get(g)!.push(acct);
  }
  const truePairs = pairsOf(rings.values());
  const predicted = pairsOf(clusters.values());
  let correct = 0;
  let household = 0;
  let mm = 0;
  for (const p of predicted) {
    if (truePairs.has(p)) correct++;
    const [a, b] = p.split("|");
    if (truth.role.get(a) === "household" && truth.group.get(a) === truth.group.get(b)) household++;
    if (truth.role.get(a) === "market_maker" && truth.role.get(b) === "market_maker") mm++;
  }
  const sizes = [...clusters.values()].map((m) => m.length);
  return {
    true_pairs: truePairs.size,
    predicted_pairs: predicted.size,
    correct_pairs: correct,
    precision: predicted.size ? correct / predicted.size : null,
    recall: truePairs.size ? correct / truePairs.size : null,
    clusters: clusters.size,
    largest_cluster: sizes.length ? Math.max(...sizes) : 0,
    household_pairs_linked: household,
    market_maker_pairs_linked: mm,
  };
}

export async function evaluatePublished(db: Db, truth: Truth): Promise<LinkEvaluation> {
  const r = await db.query("SELECT cluster_id, members FROM clusters");
  return evaluateClusters(new Map(r.rows.map((x) => [x.cluster_id, x.members])), truth);
}

/** The same evidence clustered under weaker settings, to show what each safeguard buys. */
export function ablation(ev: EvidenceSet, cfg: LinkingConfig, truth: Truth) {
  const variants: { name: string; cfg: LinkingConfig }[] = [
    { name: "as configured", cfg },
    { name: "no rarity weighting or identifier cap", cfg: { ...cfg, rarity_weighting: false } },
    { name: "one evidence family is enough", cfg: { ...cfg, require_two_families: false } },
    { name: "one family, no rarity weighting", cfg: { ...cfg, require_two_families: false, rarity_weighting: false } },
    {
      name: "naive: no rarity, one family, no size cap",
      cfg: { ...cfg, rarity_weighting: false, require_two_families: false, max_cluster_size: 1_000_000 },
    },
  ];
  return variants.map((v) => ({ variant: v.name, ...evaluateClusters(computeLinks(ev, v.cfg).clustering.clusters, truth) }));
}
