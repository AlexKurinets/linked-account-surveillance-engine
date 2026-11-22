import fs from "node:fs";
import { ClaudeReportModel, ScriptedReportModel } from "./agent/model.js";
import { runReport } from "./agent/report.js";
import { buildApi } from "./api.js";
import { loadConfig } from "./config.js";
import { connect, getConfigValue, migrate } from "./db.js";
import { ablation, evaluatePublished, loadTruth } from "./linking/evaluate.js";
import { loadEvidence, runLinker } from "./linking/linker.js";
import { replay, runEngineLive, runScheduler } from "./jobs.js";
import { defaultStart, runLive, seed } from "./sim/seed.js";
import { summary } from "./summary.js";

function flag(args: string[], name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  const db = connect();
  const days = Number(flag(args, "days", process.env.SURV_DAYS ?? "14"));
  const worldOpts = () => ({
    seed: Number(flag(args, "seed", "7")),
    start: flag(args, "start") ?? defaultStart(Date.now(), days),
    days,
    accounts: Number(flag(args, "accounts", process.env.SURV_ACCOUNTS ?? "3000")),
  });
  try {
    switch (cmd) {
      case "migrate":
        await migrate(db);
        console.log("schema ready");
        break;
      case "seed":
        await migrate(db);
        console.log(JSON.stringify(await seed(db, worldOpts())));
        break;
      case "replay":
        await replay(db, cfg);
        break;
      case "bootstrap": {
        // Idempotent start-up for the Compose stack: schema, synthetic history, replay.
        await migrate(db);
        if (!(await getConfigValue(db, "world"))) await seed(db, worldOpts());
        await replay(db, cfg);
        const ready = process.env.SURV_READY_FILE;
        if (ready) fs.writeFileSync(ready, new Date().toISOString());
        console.log("bootstrap complete");
        break;
      }
      case "engine":
        await runEngineLive(db, cfg);
        break;
      case "live":
        await runLive(db, { mmRate: Number(flag(args, "mm-rate", "0")), mmOnly: args.includes("--mm-only"), stopAfterMs: flag(args, "stop-after-seconds") ? Number(flag(args, "stop-after-seconds")) * 1000 : undefined });
        break;
      case "link":
        console.log(JSON.stringify(await runLinker(db, new Date(), cfg.engine.linking)));
        break;
      case "evaluate": {
        const truth = await loadTruth(db);
        console.log(JSON.stringify({ published: await evaluatePublished(db, truth) }, null, 2));
        const ev = await loadEvidence(db, new Date(8.64e15));
        console.table(ablation(ev, cfg.engine.linking, truth).map((r) => ({
          variant: r.variant,
          precision: r.precision?.toFixed(3),
          recall: r.recall?.toFixed(3),
          clusters: r.clusters,
          largest: r.largest_cluster,
          households: r.household_pairs_linked,
          market_makers: r.market_maker_pairs_linked,
        })));
        break;
      }
      case "report": {
        const day = flag(args, "day");
        if (!day) throw new Error("--day YYYY-MM-DD is required");
        const llm = flag(args, "llm", process.env.SURV_REPORT_LLM ?? "scripted");
        const model = llm === "claude" ? new ClaudeReportModel() : new ScriptedReportModel(Number(flag(args, "faults", "0")));
        const out = await runReport(db, day, model, cfg);
        console.log(JSON.stringify({ source: out.source, attempts: out.attempts, errors: out.errors, tool_calls: out.toolCalls }, null, 2));
        const md = await db.query("SELECT markdown FROM reports WHERE day = $1", [day]);
        console.log(md.rows[0].markdown);
        break;
      }
      case "summary":
        console.log(await summary(db, cfg));
        break;
      case "scheduler":
        await runScheduler(db, cfg, { once: args.includes("--once") });
        break;
      case "api": {
        const app = buildApi(db, cfg);
        const port = Number(flag(args, "port", process.env.API_PORT ?? "8080"));
        await app.listen({ host: "0.0.0.0", port });
        console.log(`api listening on ${port}`);
        return; // keep the pool open
      }
      default:
        console.log("commands: migrate | seed | replay | bootstrap | engine | live | link | evaluate | summary | report --day D | scheduler [--once] | api");
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  if (cmd !== "api" && cmd !== "engine") await db.end();
}

main();
