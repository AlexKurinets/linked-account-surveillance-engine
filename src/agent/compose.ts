import type { MemoryUpdate, OpenItem } from "./tools.js";
import type { Report } from "./validate.js";

/**
 * Deterministic report writer. The template fallback uses it directly, and the
 * offline scripted model uses it after collecting the same tool results through
 * the agent loop. It only quotes numbers it was handed.
 */
export interface ComposeInput {
  day: string;
  openItems: OpenItem[];
  scorecard: any;
  alerts: any;
  changes: any;
  clusters: Record<string, any>;
}

/** Clusters worth a look: everything already open plus every cluster touched by today's alerts. */
export function candidateClusters(openItems: OpenItem[], alerts: any): string[] {
  const ids = new Set<string>(openItems.filter((o) => o.subject_type === "cluster").map((o) => o.subject_id));
  for (const a of alerts?.alerts ?? []) if (a.cluster_id) ids.add(a.cluster_id);
  return [...ids].sort();
}

const fmt = (x: unknown) => (x === null || x === undefined ? "n/a" : String(x));

export function composeReport(input: ComposeInput): { report: Report; updates: MemoryUpdate[] } {
  const open = new Map(input.openItems.map((o) => [`${o.subject_type}:${o.subject_id}`, o]));
  const decisions: Report["decisions_needed"] = [];
  const closed: Report["closed_items"] = [];
  const updates: MemoryUpdate[] = [];
  const keep = (type: OpenItem["subject_type"], id: string, why: string, action: string) => {
    decisions.push({ subject_type: type, subject_id: id, why, recommended_action: action });
    updates.push({ subject_type: type, subject_id: id, action: open.has(`${type}:${id}`) ? "carry" : "open", note: why });
  };
  const close = (type: OpenItem["subject_type"], id: string, reason: string) => {
    closed.push({ subject_type: type, subject_id: id, reason });
    updates.push({ subject_type: type, subject_id: id, action: "close", note: reason, reason });
  };

  // Clusters
  for (const id of candidateClusters(input.openItems, input.alerts)) {
    const c = input.clusters[id];
    const isOpen = open.has(`cluster:${id}`);
    if (!c || c.error) {
      if (isOpen) close("cluster", id, "The cluster no longer exists after the latest linking pass.");
      continue;
    }
    if (c.analyst_action) {
      if (isOpen) close("cluster", id, `Analysts ${c.analyst_action.action} it on ${c.analyst_action.day}: ${c.analyst_action.note}.`);
      continue;
    }
    if (c.confirmed_alerts >= 1) {
      const top = c.links[0];
      const fam = top ? top.families.join(" and ") : "linked";
      keep(
        "cluster",
        id,
        `${c.confirmed_alerts} confirmed alert(s) across ${c.size} linked accounts; strongest link ${top?.a} to ${top?.b} rests on ${fam} evidence (score ${top?.score}).`,
        `Review the link evidence and decide whether to restrict all ${c.size} accounts.`,
      );
    } else if (isOpen) {
      keep("cluster", id, `Still waiting for verdicts on ${c.alerts.length} alert(s) in this ${c.size}-account cluster.`, "No action until the verdicts land.");
    }
  }

  // Merges the size cap refused
  const reviews: any[] = input.changes?.merges_waiting_for_review ?? [];
  const reviewIds = new Set(reviews.map((r) => r.review_id));
  for (const r of reviews.slice(0, 3)) {
    keep("link_review", r.review_id, `A link scoring ${r.score} was held back because the ${r.reason}.`, "Check whether the two clusters are one operator before merging by hand.");
  }
  for (const o of input.openItems.filter((x) => x.subject_type === "link_review")) {
    if (!reviewIds.has(o.subject_id) || !decisions.some((d) => d.subject_id === o.subject_id)) {
      if (!reviewIds.has(o.subject_id)) close("link_review", o.subject_id, "The merge is no longer waiting for review.");
      else keep("link_review", o.subject_id, o.note, "Check whether the two clusters are one operator before merging by hand.");
    }
  }

  // Rules with low precision
  const low: any[] = input.changes?.rules_below_25pct_precision ?? [];
  const lowIds = new Set(low.map((r) => r.rule));
  for (const r of low) {
    keep("rule", r.rule, `Rule ${r.rule} has ${r.precision_pct}% precision on ${r.alerts} alerts over the window.`, "Review the rule's conditions with the analysts; the nightly refit already weights it by its verdicts.");
  }
  for (const o of input.openItems.filter((x) => x.subject_type === "rule")) {
    if (lowIds.has(o.subject_id)) continue;
    const now = input.scorecard?.today?.by_rule?.[o.subject_id];
    close("rule", o.subject_id, now && now.precision_pct !== null ? `Precision is back to ${now.precision_pct}% on ${now.alerts} alerts.` : "Too few recent alerts to judge the rule.");
  }

  // Summary and changes
  const s = input.scorecard?.today;
  const t = input.alerts?.totals;
  const parts: string[] = [];
  if (t) {
    parts.push(`On ${input.day} the engine raised ${t.alerts} alerts, ${t.in_clusters} of them on linked accounts.`);
    parts.push(`${t.confirmed} have been confirmed, ${t.rejected} rejected and ${t.pending} are waiting for a verdict.`);
  }
  if (s) {
    if (s.precision_pct !== null) parts.push(`Precision on the resolved alerts is ${s.precision_pct}%.`);
    if (s.recall_est_pct !== null) {
      parts.push(`Estimated recall over the last ${s.recall_window_days} days is ${s.recall_est_pct}% (interval ${fmt(s.recall_interval_pct[0])}% to ${fmt(s.recall_interval_pct[1])}%).`);
    }
    parts.push(`The alert threshold is ${s.threshold} under ${s.champion}.`);
  }
  parts.push(decisions.length ? `${decisions.length} item(s) need a decision.` : "Nothing needs a decision today.");

  const changes: string[] = [];
  for (const m of input.changes?.models ?? []) {
    if (m.decided_day === input.day && m.status === "champion" && m.shadow) {
      changes.push(`${m.version} was promoted after ${m.shadow.cases} shadow cases: log loss ${m.shadow.log_loss_challenger} against ${m.shadow.log_loss_champion} for the model it replaced.`);
    } else if (m.decided_day === input.day && m.status === "retired" && m.shadow) {
      changes.push(`${m.version} was retired after ${m.shadow.cases} shadow cases: log loss ${m.shadow.log_loss_challenger} against ${m.shadow.log_loss_champion} for the champion.`);
    } else if (m.status === "challenger" && m.created_day === input.day) {
      changes.push(`${m.version} was fitted on the latest verdicts and is now scoring in shadow.`);
    }
  }
  const th = input.changes?.threshold;
  if (th && th.previous !== null && th.today !== null && th.previous !== th.today) changes.push(`The threshold moved from ${th.previous} to ${th.today}.`);

  return { report: { day: input.day, summary: parts.join(" "), decisions_needed: decisions, closed_items: closed, changes }, updates };
}
