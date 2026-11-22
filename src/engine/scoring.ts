import type { Config, Rule } from "../config.js";
import { scoreFeatureNames } from "../config.js";
import type { Features } from "./state.js";

/** True when every condition of an analyst rule holds. Unknown features never match. */
export function ruleFires(rule: Rule, f: Features): boolean {
  return rule.all.every((c) => {
    const v = f[c.feature];
    if (v === undefined || Number.isNaN(v)) return false;
    switch (c.op) {
      case ">":
        return v > c.value;
      case ">=":
        return v >= c.value;
      case "<":
        return v < c.value;
      case "<=":
        return v <= c.value;
      case "==":
        return v === c.value;
    }
  });
}

/**
 * Bayesian logistic regression exported by models/surveil_models/scorer.py:
 * a MAP weight vector and the Laplace-approximation covariance around it.
 */
export interface ScoreModel {
  version: string;
  features: string[];
  mean: number[];
  cov: number[][];
}

export interface Score {
  version: string;
  p: number;
  lo: number;
  hi: number;
  eta: number;
  sd: number;
  contributions: Record<string, number>;
}

export const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Inputs to the scorer, by name. Missing extra inputs default to 0. */
export function scoreInputs(cfg: Config, f: Features, extra: Record<string, number>): Record<string, number> {
  const x: Record<string, number> = { intercept: 1 };
  for (const r of cfg.rules) x[`rule:${r.id}`] = ruleFires(r, f) ? 1 : 0;
  for (const e of cfg.engine.scoring.extra_features) x[e.name] = extra[e.name] ?? 0;
  return x;
}

export function score(model: ScoreModel, x: Record<string, number>, z: number): Score {
  const v = model.features.map((n) => x[n] ?? 0);
  let eta = 0;
  const contributions: Record<string, number> = {};
  for (let i = 0; i < v.length; i++) {
    const c = model.mean[i] * v[i];
    eta += c;
    if (v[i] !== 0 && model.features[i] !== "intercept") contributions[model.features[i]] = c;
  }
  // Variance of eta under the weight posterior: v' Σ v.
  let variance = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === 0) continue;
    for (let j = 0; j < v.length; j++) if (v[j] !== 0) variance += v[i] * model.cov[i][j] * v[j];
  }
  const sd = Math.sqrt(Math.max(0, variance));
  return { version: model.version, p: sigmoid(eta), lo: sigmoid(eta - z * sd), hi: sigmoid(eta + z * sd), eta, sd, contributions };
}

/** The day-one model: exactly the analysts' weights, with the prior's width as its uncertainty. */
export function analystModel(cfg: Config, version = "analyst-v1"): ScoreModel {
  const names = scoreFeatureNames(cfg);
  const s = cfg.engine.scoring;
  const mean = names.map((n) => {
    if (n === "intercept") return s.intercept_prior_mean;
    if (n.startsWith("rule:")) return cfg.rules.find((r) => `rule:${r.id}` === n)!.weight;
    return s.extra_features.find((e) => e.name === n)!.prior_mean;
  });
  const cov = names.map((n, i) =>
    names.map((_, j) => (i === j ? (n === "intercept" ? s.intercept_prior_sd : s.weight_prior_sd) ** 2 : 0)),
  );
  return { version, features: names, mean, cov };
}
