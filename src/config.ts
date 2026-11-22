import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const Condition = z.object({
  feature: z.string(),
  op: z.enum([">", ">=", "<", "<=", "=="]),
  value: z.number(),
});

export const RuleSchema = z.object({
  id: z.string().regex(/^[a-z_]+$/),
  description: z.string(),
  all: z.array(Condition).min(1),
  weight: z.number(),
});
export type Rule = z.infer<typeof RuleSchema>;

const RulesFile = z.object({ version: z.string(), note: z.string().optional(), rules: z.array(RuleSchema).min(1) });

const EngineFile = z.object({
  state: z.object({
    short_half_life_minutes: z.number().positive(),
    long_half_life_minutes: z.number().positive(),
    device_window_days: z.number().positive(),
    ip_window_hours: z.number().positive(),
  }),
  scoring: z.object({
    intercept_prior_mean: z.number(),
    intercept_prior_sd: z.number().positive(),
    weight_prior_sd: z.number().positive(),
    extra_features: z.array(z.object({ name: z.string(), prior_mean: z.number(), description: z.string() })),
    interval_z: z.number().positive(),
  }),
  anomaly: z.object({
    features: z.array(z.string()).min(1),
    n_trees: z.number().int().positive(),
    max_samples: z.number().int().positive(),
    train_window_days: z.number().positive(),
  }),
  alerts: z.object({
    daily_budget: z.number().int().positive(),
    initial_threshold: z.number().min(0).max(1),
    threshold_floor: z.number().min(0).max(1),
    threshold_window_days: z.number().int().positive(),
    cluster_cooldown_hours: z.number().positive(),
    cooldown_override_rise: z.number().min(0),
    rejected_suppression_days: z.number().positive(),
    anomaly_lane: z.object({ daily_budget: z.number().int().nonnegative(), min_rarity: z.number().positive() }),
  }),
  linking: z.object({
    rarity_weighting: z.boolean(),
    identifier_cap: z.number().int().positive(),
    ip_coincidence_seconds: z.number().positive(),
    handoff_seconds: z.number().positive(),
    handoff_min_count: z.number().int().positive(),
    pair_fill_min_count: z.number().int().positive(),
    family_min_score: z.number().nonnegative(),
    link_threshold: z.number().nonnegative(),
    require_two_families: z.boolean(),
    max_cluster_size: z.number().int().positive(),
    coactivity: z.object({
      window_days: z.number().positive(),
      stop_minute_quantile: z.number().gt(0).lt(1),
      alpha: z.number().gt(0).lt(1),
      min_shared_minutes: z.number().int().positive(),
    }),
  }),
  outcomes: z.object({
    audit_base_rate: z.number().gt(0).lt(1),
    audit_near_threshold_rate: z.number().gt(0).lt(1),
    verdict_noise: z.number().min(0).lt(0.5),
    audit_verdict_noise: z.number().min(0).lt(0.5),
    recall_window_days: z.number().int().positive(),
    shadow_days: z.number().positive(),
    shadow_min_cases: z.number().int().positive(),
  }),
});
export type EngineConfig = z.infer<typeof EngineFile>;
export type LinkingConfig = EngineConfig["linking"];

export interface Config {
  engine: EngineConfig;
  rulesVersion: string;
  rules: Rule[];
}

export function configDir(): string {
  return process.env.SURV_CONFIG_DIR ?? path.resolve("config");
}

let cached: Config | null = null;

export function loadConfig(dir = configDir()): Config {
  if (cached && dir === configDir()) return cached;
  const engine = EngineFile.parse(JSON.parse(fs.readFileSync(path.join(dir, "engine.json"), "utf8")));
  const rules = RulesFile.parse(JSON.parse(fs.readFileSync(path.join(dir, "rules.json"), "utf8")));
  const ids = new Set(rules.rules.map((r) => r.id));
  if (ids.size !== rules.rules.length) throw new Error("duplicate rule ids in rules.json");
  const cfg = { engine, rulesVersion: rules.version, rules: rules.rules };
  if (dir === configDir()) cached = cfg;
  return cfg;
}

/** Names of the scorer's inputs, in the order the weight vector uses. */
export function scoreFeatureNames(cfg: Config): string[] {
  return ["intercept", ...cfg.rules.map((r) => `rule:${r.id}`), ...cfg.engine.scoring.extra_features.map((f) => f.name)];
}
