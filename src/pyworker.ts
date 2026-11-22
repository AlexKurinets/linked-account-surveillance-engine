import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

export type PyCommand = "coactivity" | "train-anomaly" | "train-scorer";

function pythonBin(): string {
  return process.env.SURV_PYTHON ?? "python";
}

function pyEnv(): NodeJS.ProcessEnv {
  const models = path.resolve(process.env.SURV_MODELS_DIR ?? "models");
  return { ...process.env, PYTHONPATH: [models, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
}

/** A long-lived `python -m surveil_models serve` process: one JSON request and one JSON reply per line. */
export class PyWorker {
  private proc: ChildProcessWithoutNullStreams;
  private lines: AsyncIterableIterator<string>;

  constructor() {
    this.proc = spawn(pythonBin(), ["-m", "surveil_models", "serve"], { env: pyEnv() });
    this.proc.stderr.on("data", (d) => process.stderr.write(`[py] ${d}`));
    this.lines = readline.createInterface({ input: this.proc.stdout })[Symbol.asyncIterator]();
  }

  async run(cmd: PyCommand, asOf: number): Promise<any> {
    this.proc.stdin.write(JSON.stringify({ cmd, as_of: new Date(asOf).toISOString() }) + "\n");
    const next = await this.lines.next();
    if (next.done) throw new Error("python worker exited");
    const msg = JSON.parse(next.value);
    if (!msg.ok) throw new Error(`python ${cmd} failed: ${msg.error}`);
    return msg.result;
  }

  close(): void {
    this.proc.stdin.end();
  }
}

/** One-shot run, for the scheduler. */
export function runPython(cmd: PyCommand, asOf: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(pythonBin(), ["-m", "surveil_models", cmd, "--as-of", new Date(asOf).toISOString()], { env: pyEnv() });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => process.stderr.write(`[py] ${d}`));
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop()!)) : reject(new Error(`python ${cmd} exited ${code}`))));
  });
}
