import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { AnomalyModel } from "./engine/anomaly.js";
import { analystModel, type ScoreModel } from "./engine/scoring.js";

export interface LoadedModels {
  champion: ScoreModel;
  challenger: ScoreModel | null;
  challengerCreated: number | null;
  anomaly: AnomalyModel | null;
}

/** Make sure a champion exists. On a fresh database it is the analysts' own weights. */
export async function ensureChampion(db: Db, cfg: Config, at: Date): Promise<void> {
  const r = await db.query("SELECT 1 FROM models WHERE kind = 'score' AND status = 'champion'");
  if (r.rows.length) return;
  const m = analystModel(cfg);
  await db.query(
    `INSERT INTO models (version, kind, status, params, metrics, created_at, decided_at)
     VALUES ($1, 'score', 'champion', $2, $3, $4, $4) ON CONFLICT (version) DO NOTHING`,
    [m.version, JSON.stringify({ features: m.features, mean: m.mean, cov: m.cov }), JSON.stringify({ source: "analyst weights from config/rules.json" }), at],
  );
}

export async function loadModels(db: Db): Promise<LoadedModels> {
  const r = await db.query(
    `SELECT version, kind, status, params, created_at FROM models
     WHERE status IN ('champion','challenger') ORDER BY created_at DESC`,
  );
  const score = (row: any): ScoreModel => ({ version: row.version, features: row.params.features, mean: row.params.mean, cov: row.params.cov });
  const champ = r.rows.find((x) => x.kind === "score" && x.status === "champion");
  if (!champ) throw new Error("no champion score model; run ensureChampion first");
  const chall = r.rows.find((x) => x.kind === "score" && x.status === "challenger");
  const anom = r.rows.find((x) => x.kind === "anomaly" && x.status === "champion");
  return {
    champion: score(champ),
    challenger: chall ? score(chall) : null,
    challengerCreated: chall ? new Date(chall.created_at).getTime() : null,
    anomaly: anom ? ({ version: anom.version, ...anom.params } as AnomalyModel) : null,
  };
}
