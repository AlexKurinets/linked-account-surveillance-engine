import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { evaluatePublished, loadTruth } from "./linking/evaluate.js";

/** Read-only HTTP API over the engine's tables. */
export function buildApi(db: Db, cfg: Config): FastifyInstance {
  const app = Fastify({ logger: false });
  const day = (q: unknown) => (typeof (q as any)?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test((q as any).day) ? (q as any).day : null);

  app.get("/health", async () => {
    const r = await db.query("SELECT (SELECT count(*) FROM events) AS events, (SELECT event_time FROM consumer_cursor WHERE consumer = 'engine') AS engine_event_time");
    return { ok: true, ...r.rows[0] };
  });

  app.get("/accounts/:id", async (req, reply) => {
    const id = (req.params as any).id;
    const s = await db.query("SELECT account_id, event_time, features, score FROM account_state WHERE account_id = $1", [id]);
    if (!s.rows.length) return reply.code(404).send({ error: "unknown account" });
    const c = await db.query("SELECT cluster_id FROM account_cluster WHERE account_id = $1", [id]);
    const d = await db.query("SELECT id, ts, kind, p, verdict FROM decisions WHERE account_id = $1 ORDER BY ts DESC LIMIT 20", [id]);
    return { ...s.rows[0], cluster_id: c.rows[0]?.cluster_id ?? null, decisions: d.rows };
  });

  app.get("/clusters", async () => {
    const r = await db.query(
      `SELECT c.cluster_id, c.members, c.min_link_score, cs.features AS state, a.action AS analyst_action
       FROM clusters c LEFT JOIN cluster_state cs USING (cluster_id) LEFT JOIN cluster_actions a USING (cluster_id)
       ORDER BY array_length(c.members, 1) DESC, c.cluster_id`,
    );
    return { count: r.rows.length, clusters: r.rows };
  });

  app.get("/clusters/:id", async (req, reply) => {
    const id = (req.params as any).id;
    const c = await db.query("SELECT * FROM clusters WHERE cluster_id = $1", [id]);
    if (!c.rows.length) return reply.code(404).send({ error: "unknown cluster" });
    const links = await db.query("SELECT a, b, score, families, evidence FROM links WHERE a = ANY($1) ORDER BY score DESC", [c.rows[0].members]);
    const state = await db.query("SELECT event_time, features FROM cluster_state WHERE cluster_id = $1", [id]);
    return { ...c.rows[0], state: state.rows[0] ?? null, links: links.rows };
  });

  app.get("/alerts", async (req) => {
    const d = day(req.query);
    const r = await db.query(
      `SELECT id, ts, account_id, cluster_id, p, threshold, champion, reasons, verdict FROM decisions
       WHERE kind = 'alert' AND ($1::date IS NULL OR day = $1) ORDER BY ts DESC LIMIT 200`,
      [d],
    );
    return { count: r.rows.length, alerts: r.rows };
  });

  app.get("/scorecard", async () => {
    const r = await db.query("SELECT * FROM scorecard_daily ORDER BY day");
    return { days: r.rows };
  });

  app.get("/models", async () => {
    const r = await db.query("SELECT version, kind, status, metrics, created_at, decided_at FROM models ORDER BY created_at");
    return { models: r.rows.map((m) => ({ ...m, metrics: m.kind === "anomaly" ? m.metrics : m.metrics })) };
  });

  app.get("/reports/latest", async (_req, reply) => {
    const r = await db.query("SELECT * FROM reports ORDER BY day DESC LIMIT 1");
    return r.rows[0] ?? reply.code(404).send({ error: "no report yet" });
  });

  app.get("/reports/:day", async (req, reply) => {
    const r = await db.query("SELECT * FROM reports WHERE day = $1", [(req.params as any).day]);
    return r.rows[0] ?? reply.code(404).send({ error: "no report for that day" });
  });

  app.get("/open-items", async () => {
    const r = await db.query("SELECT * FROM open_items ORDER BY status DESC, opened_day, subject_id");
    return { items: r.rows };
  });

  app.get("/metrics/freshness", async () => {
    const r = await db.query(
      `SELECT count(*) AS batches, sum(events) AS events,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_p50_ms) AS median_batch_p50_ms,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_p95_ms) AS median_batch_p95_ms,
              max(lag_p95_ms) AS worst_batch_p95_ms, max(ts) AS last_batch
       FROM engine_metrics WHERE mode = 'live' AND ts > now() - interval '15 minutes'`,
    );
    return { window: "last 15 minutes of live batches", ...r.rows[0] };
  });

  app.get("/linking/evaluation", async () => ({
    note: "Pairwise precision and recall of the published clusters against the synthetic ground truth.",
    ...(await evaluatePublished(db, await loadTruth(db))),
    max_cluster_size: cfg.engine.linking.max_cluster_size,
  }));

  return app;
}
