import Anthropic from "@anthropic-ai/sdk";
import { candidateClusters, composeReport } from "./compose.js";
import { groundedNumbers } from "./validate.js";
import type { Tool } from "./tools.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** One model turn: the only parts of a Messages API response the agent loop reads. */
export type ModelTurn = Pick<BetaMessage, "content" | "stop_reason">;

export interface ReportModel {
  readonly name: string;
  next(req: { system: string; tools: Tool[]; messages: MessageParam[] }): Promise<ModelTurn>;
}

/**
 * Claude through the Messages API, with a tool loop we host ourselves so the
 * checks and the memory commit stay in our code. Production ran the same loop
 * on Bedrock (AnthropicBedrockMantle from @anthropic-ai/bedrock-sdk, with the
 * client-side refusal fallback middleware, since server-side fallbacks are not
 * offered there).
 */
export class ClaudeReportModel implements ReportModel {
  readonly name: string;
  constructor(
    private client = new Anthropic(),
    private model = process.env.SURV_REPORT_MODEL ?? "claude-opus-5-5",
  ) {
    this.name = this.model;
  }

  async next(req: { system: string; tools: Tool[]; messages: MessageParam[] }): Promise<ModelTurn> {
    return this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // On a policy decline the API re-runs the request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: req.system,
      tools: req.tools,
      messages: req.messages,
    });
  }
}

const text = (t: string): Anthropic.Beta.Messages.BetaTextBlock => ({ type: "text", text: t, citations: null });

/**
 * A deterministic stand-in for the model, so the whole pipeline (tool calls,
 * memory staging, checks, retry, publish) runs in CI and in Docker without an
 * API key. It plays a model's part turn by turn: read the four overview tools
 * in one parallel turn, look up every cluster that matters, stage the memory
 * updates, then write the report from what the tools returned.
 *
 * `faults` makes the first N drafts quote a two-day alert total it summed
 * itself and got wrong, which is the failure the number check exists for.
 */
export class ScriptedReportModel implements ReportModel {
  readonly name: string;
  private ids = new Map<string, string>();
  private n = 0;
  private drafts = 0;
  private results: Record<string, any> = {};
  private clusters: Record<string, any> = {};
  private day = "";

  constructor(private faults = 0, private brokenDrafts = 0) {
    this.name = faults || brokenDrafts ? `scripted(faults=${faults},broken=${brokenDrafts})` : "scripted";
  }

  private call(name: string, input: Record<string, unknown>): Anthropic.Beta.Messages.BetaToolUseBlock {
    const id = `toolu_scripted_${++this.n}`;
    this.ids.set(id, name);
    return { type: "tool_use", id, name, input };
  }

  private absorb(messages: MessageParam[]): void {
    const last = messages[messages.length - 1];
    if (last.role !== "user" || typeof last.content === "string") return;
    for (const block of last.content) {
      if (block.type !== "tool_result") continue;
      const name = this.ids.get(block.tool_use_id);
      const body = typeof block.content === "string" ? block.content : "";
      const value = JSON.parse(body);
      if (name === "get_cluster") this.clusters[value.cluster_id ?? `missing-${block.tool_use_id}`] = value;
      else if (name) this.results[name] = value;
    }
  }

  async next(req: { system: string; tools: Tool[]; messages: MessageParam[] }): Promise<ModelTurn> {
    if (req.messages.length === 1) {
      this.results = {};
      this.clusters = {};
      this.drafts = 0;
      const first = req.messages[0].content;
      this.day = (typeof first === "string" ? first : JSON.stringify(first)).match(/\d{4}-\d{2}-\d{2}/)![0];
      return {
        stop_reason: "tool_use",
        content: [
          text("Starting with the open items and the day's overview."),
          this.call("get_open_items", {}),
          this.call("get_scorecard", { day: this.day }),
          this.call("list_alerts", { day: this.day }),
          this.call("get_model_changes", { day: this.day }),
        ],
      };
    }
    this.absorb(req.messages);
    const open = this.results.get_open_items?.open_items ?? [];
    const wanted = candidateClusters(open, this.results.list_alerts).filter((id) => !(id in this.clusters));
    if (wanted.length && !Object.keys(this.clusters).length) {
      return { stop_reason: "tool_use", content: wanted.map((id) => this.call("get_cluster", { cluster_id: id })) };
    }
    const composed = composeReport({
      day: this.day,
      openItems: open,
      scorecard: this.results.get_scorecard,
      alerts: this.results.list_alerts,
      changes: this.results.get_model_changes,
      clusters: this.clusters,
    });
    if (!this.results.update_open_items) {
      this.results.update_open_items = { pending: true };
      return { stop_reason: "tool_use", content: [this.call("update_open_items", { updates: composed.updates })] };
    }
    this.drafts++;
    const report = { ...composed.report } as Record<string, unknown>;
    if (this.drafts <= this.brokenDrafts) delete report.decisions_needed;
    else if (this.drafts <= this.faults) {
      const today = this.results.get_scorecard?.today?.alerts ?? 0;
      const yesterday = this.results.get_scorecard?.previous_day?.alerts ?? 0;
      const grounded = groundedNumbers([...Object.values(this.results), ...Object.values(this.clusters)]);
      let sum = today + yesterday + 1;
      while (grounded.has(String(sum))) sum++;
      report.summary = `${composed.report.summary} That makes ${sum} alerts over the last two days.`;
    }
    return { stop_reason: "end_turn", content: [text(JSON.stringify(report))] };
  }
}

export function modelFromEnv(): ReportModel {
  return (process.env.SURV_REPORT_LLM ?? "scripted") === "claude" ? new ClaudeReportModel() : new ScriptedReportModel();
}
