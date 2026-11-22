import { modelFromEnv, type ReportModel } from "./agent/model.js";
import { runReport } from "./agent/report.js";
import type { Config } from "./config.js";
import { type Db, getConfigValue, setConfigValue } from "./db.js";
import { Engine } from "./engine/engine.js";
import { runLinker } from "./linking/linker.js";
import { ensureChampion, loadModels } from "./models.js";
import { applyVerdicts, decideClusters, sampleAudit } from "./outcomes/analyst.js";
import { decideChallenger, updateThreshold } from "./outcomes/promote.js";
import { computeScorecard, refreshPrecision } from "./outcomes/scorecard.js";
import { PyWorker, runPython, type PyCommand } from "./pyworker.js";
import type { WorldOptions } from "./sim/world.js";
import { addDays, DAY, dayOf, dayStart, HOUR, MINUTE } from "./util.js";

type Py = (cmd: PyCommand, asOf: number) => Promise<any>;

/**
 * The nightly sequence for one day, in the order production ran it: audit
 * sample, analyst cluster decisions, scorecard, the shadow decision on any
 * waiting challenger, a refit (skipped while a challenger is in shadow), a new
 * isolation forest, tomorrow's threshold, and the morning report.
 */
export async function nightly(db: Db, cfg: Config, day: string, threshold: number, py: Py, model: ReportModel) {
  // end of the day, or now when run on a day that hasn't finished (scheduler --once)
  const now = Math.min(dayStart(addDays(day, 1)) - 1, Date.now());
  await applyVerdicts(db, now, cfg);
  let models = await loadModels(db);
  const audited = await sampleAudit(db, day, threshold, models, cfg);
  const decided = await decideClusters(db, day);
  const scorecard = await computeScorecard(db, day, models, threshold, cfg);
  for (const back of [1, 2]) await refreshPrecision(db, addDays(day, -back));
  const shadow = await decideChallenger(db, now, models, cfg);
  const refit = await py("train-scorer", now);
  const forest = await py("train-anomaly", now);
  models = await loadModels(db);
  const th = await updateThreshold(db, day, models, cfg);
  const report = await runReport(db, day, model, cfg);
  return { audited, decided, scorecard, shadow, refit, forest, threshold: th, report: { source: report.source, attempts: report.attempts } };
}

/** Replay the seeded history day by day through the same code the live system runs. Resumable. */
export async function replay(db: Db, cfg: Config, log = console.log): Promise<void> {
  const world = await getConfigValue<WorldOptions>(db, "world");
  if (!world) throw new Error("seed the database first");
  const done = await getConfigValue<{ last_day: string }>(db, "replay_progress");
  const engine = new Engine(db, cfg);
  await engine.init();
  const worker = new PyWorker();
  const py: Py = (cmd, asOf) => worker.run(cmd, asOf);
  const model = modelFromEnv();
  try {
    for (let d = 0; d < world.days; d++) {
      const day = addDays(world.start, d);
      if (done && day <= done.last_day) continue;
      const t0 = dayStart(day);
      let events = 0;
      for (const h of [6, 12, 18, 24]) {
        const until = t0 + h * HOUR - 1;
        events += await engine.runUntil(until);
        await py("coactivity", until);
        await runLinker(db, new Date(until), cfg.engine.linking);
        await applyVerdicts(db, until, cfg);
        await engine.refresh();
      }
      const n = await nightly(db, cfg, day, engine.threshold, py, model);
      await engine.refresh(true);
      await setConfigValue(db, "replay_progress", { last_day: day }, new Date(t0 + DAY));
      // the live scheduler should not re-run a night the replay already ran
      await setConfigValue(db, "nightly_ran_for", { day }, new Date(t0 + DAY));
      const s = n.scorecard;
      log(
        `${day}: ${events} events, ${s.alerts} alerts, threshold ${s.threshold.toFixed(3)}, champion ${s.champion}` +
          `, audit ${n.audited}, shadow ${n.shadow.action}, refit ${n.refit.version ?? n.refit.skipped}, report ${n.report.source}`,
      );
    }
  } finally {
    worker.close();
  }
}

/** Live consumer: wake on NOTIFY (or every second), process what arrived, pick up job outputs every 30 s. */
export async function runEngineLive(db: Db, cfg: Config, log = console.log): Promise<never> {
  const engine = new Engine(db, cfg);
  await engine.init();
  const listener = await db.connect();
  let wake: (() => void) | null = null;
  listener.on("notification", () => wake?.());
  await listener.query("LISTEN events");
  let lastRefresh = Date.now();
  log(`engine live from event ${engine.cursor.event}`);
  for (;;) {
    const n = await engine.step({ live: true, batchSize: 1000 });
    if (Date.now() - lastRefresh > 30_000) {
      await engine.refresh();
      lastRefresh = Date.now();
    }
    if (!n) await new Promise<void>((r) => {
      wake = r;
      setTimeout(r, 1000);
    });
  }
}

/** Live job schedule. `once` runs every job immediately and exits (used by the smoke test). */
export async function runScheduler(db: Db, cfg: Config, opts: { once: boolean }, log = console.log): Promise<void> {
  const last: Record<string, number> = {};
  const model = modelFromEnv();
  const due = (name: string, every: number) => {
    const now = Date.now();
    if (opts.once || !last[name] || now - last[name] >= every) {
      last[name] = now;
      return true;
    }
    return false;
  };
  await ensureChampion(db, cfg, new Date());
  for (;;) {
    const now = Date.now();
    try {
      if (due("coactivity", 15 * MINUTE)) log("coactivity", JSON.stringify(await runPython("coactivity", now)));
      if (due("link", 5 * MINUTE)) log("link", JSON.stringify(await runLinker(db, new Date(now), cfg.engine.linking)));
      if (due("verdicts", 10 * MINUTE)) log("verdicts", await applyVerdicts(db, now, cfg));
      const today = dayOf(now);
      const reportDay = opts.once ? today : addDays(today, -1);
      const ranFor = await getConfigValue<{ day: string }>(db, "nightly_ran_for");
      if (opts.once || (now - dayStart(today) >= 6 * HOUR && ranFor?.day !== reportDay)) {
        const th = (await getConfigValue<{ value: number }>(db, "threshold"))?.value ?? cfg.engine.alerts.initial_threshold;
        const n = await nightly(db, cfg, reportDay, th, runPython, model);
        await setConfigValue(db, "nightly_ran_for", { day: reportDay }, new Date());
        log("nightly", reportDay, JSON.stringify({ ...n, scorecard: undefined }));
      }
    } catch (err) {
      log("job failed:", (err as Error).message);
      if (opts.once) throw err;
    }
    if (opts.once) return;
    await new Promise((r) => setTimeout(r, 20_000));
  }
}
