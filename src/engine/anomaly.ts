import type { Features } from "./state.js";

/**
 * Isolation forest trained by scikit-learn (models/surveil_models/anomaly.py)
 * and scored here from the exported trees. Feature indices are already mapped
 * back to the model's feature list, so trees can be evaluated directly.
 */
export interface IsolationTree {
  feature: number[];
  threshold: number[];
  left: number[];
  right: number[];
  n: number[];
}

export interface AnomalyModel {
  version: string;
  features: string[];
  max_samples: number;
  trees: IsolationTree[];
  median: number[];
  mad: number[];
  /** 1,001 evenly spaced quantiles of the training scores */
  score_quantiles: number[];
}

const EULER = 0.5772156649015329;

/** Average path length of an unsuccessful BST search, c(n), as scikit-learn defines it. */
export function averagePathLength(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
}

/**
 * Anomaly score in (0, 1]; higher means easier to isolate. Matches
 * -IsolationForest.score_samples. scikit-learn casts inputs to float32 before
 * walking the trees, so the comparison uses Math.fround or values that sit
 * exactly on a threshold go the wrong way.
 */
export function anomalyScore(model: AnomalyModel, x: number[]): number {
  let total = 0;
  for (const t of model.trees) {
    let node = 0;
    let depth = 0;
    while (t.left[node] !== -1) {
      node = Math.fround(x[t.feature[node]]) <= t.threshold[node] ? t.left[node] : t.right[node];
      depth++;
    }
    total += depth + averagePathLength(t.n[node]);
  }
  return Math.pow(2, -total / (model.trees.length * averagePathLength(model.max_samples)));
}

/**
 * How rare a score is among the accounts the forest was trained on, in powers
 * of ten: -log10(share of accounts scoring higher). 0 near the median, 1 at the
 * top 10%, 2 at the top 1%, capped at 4. Raw scores sit in a narrow band (most
 * accounts between 0.40 and 0.50), so a weight on the raw score would need to be
 * enormous before the forest could move a probability.
 */
export function anomalyRarity(model: AnomalyModel, s: number): number {
  const q = model.score_quantiles;
  let lo = 0;
  let hi = q.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (q[mid] <= s) lo = mid + 1;
    else hi = mid;
  }
  const above = 1 - (lo - 1) / (q.length - 1);
  return Math.max(0, Math.min(4, -Math.log10(Math.max(above, 1e-4))));
}

export function anomalyVector(model: AnomalyModel, f: Features): number[] {
  return model.features.map((n) => f[n] ?? 0);
}

/** The features furthest from the population median, in robust z-scores (MAD units). */
export function anomalyReasons(model: AnomalyModel, x: number[], top = 2): { feature: string; z: number }[] {
  return x
    .map((v, i) => ({ feature: model.features[i], z: (v - model.median[i]) / (1.4826 * Math.max(model.mad[i], 1e-6)) }))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, top);
}
