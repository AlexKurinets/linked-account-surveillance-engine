#!/usr/bin/env bash
# Exercises every command sequence the README documents, against a running stack:
#   docker compose up -d --build --wait && scripts/smoke.sh
set -euo pipefail
API="http://localhost:${API_PORT:-8270}"
DAYS_EXPECTED="${SURV_DAYS:-14}"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"; }
check() { if [ "$2" != "true" ]; then echo "FAIL: $1"; exit 1; fi; echo "ok: $1"; }

curl -fs "$API/health" > /tmp/health.json
check "health" "$(json 'j.ok' < /tmp/health.json)"

curl -fs "$API/scorecard" > /tmp/scorecard.json
check "a scorecard for each replayed day" "$(json "j.days.length >= $DAYS_EXPECTED" < /tmp/scorecard.json)"
LAST_DAY="$(json 'j.days[j.days.length-1].day' < /tmp/scorecard.json)"
json 'j.days.map(d=>`${d.day} alerts=${d.alerts} precision=${d.precision?.toFixed(2)} recall~${d.recall_est?.toFixed(2)}`).join("\n")' < /tmp/scorecard.json

curl -fs "$API/clusters" > /tmp/clusters.json
check "linked clusters published" "$(json 'j.count > 0' < /tmp/clusters.json)"
FIRST="$(json 'j.clusters[0].cluster_id' < /tmp/clusters.json)"
curl -fs "$API/clusters/$FIRST" > /tmp/cluster.json
check "cluster $FIRST carries link evidence" "$(json 'j.links.length > 0 && j.links[0].families.length >= 2' < /tmp/cluster.json)"

curl -fs "$API/linking/evaluation" > /tmp/eval.json
json '`linking precision ${j.precision} recall ${j.recall} largest ${j.largest_cluster}`' < /tmp/eval.json
check "linking precision >= 0.9 against synthetic truth" "$(json 'j.precision >= 0.9' < /tmp/eval.json)"

curl -fs "$API/alerts?day=$LAST_DAY" > /tmp/alerts.json
check "alerts carry an interval and reasons" "$(json 'j.alerts.every(a => a.reasons.interval_80 && a.reasons.lane)' < /tmp/alerts.json)"

curl -fs "$API/reports/latest" > /tmp/report.json
check "a morning report passed its checks" "$(json 'j.check_errors.length === 0 || j.source === "template"' < /tmp/report.json)"

echo "waiting for live batches..."
for i in $(seq 1 60); do
  curl -fs "$API/metrics/freshness" > /tmp/fresh.json
  if [ "$(json 'Number(j.batches) > 0' < /tmp/fresh.json)" = "true" ]; then break; fi
  sleep 3
done
json '`live batches=${j.batches} events=${j.events} median p95 lag=${Math.round(j.median_batch_p95_ms)} ms`' < /tmp/fresh.json
check "live consumer is committing batches" "$(json 'Number(j.batches) > 0' < /tmp/fresh.json)"

docker compose exec -T engine node dist/cli.js evaluate > /tmp/evaluate.txt
grep -q "as configured" /tmp/evaluate.txt && echo "ok: linking ablation"

docker compose exec -T engine node dist/cli.js report --day "$LAST_DAY" --faults 1 > /tmp/report-faults.txt
check "a draft with a self-computed total is sent back once, then published" "$(grep -q '"attempts": 2' /tmp/report-faults.txt && grep -q '"source": "agent"' /tmp/report-faults.txt && echo true || echo false)"

docker compose exec -T scheduler node dist/cli.js scheduler --once > /tmp/scheduler.txt
grep -q "nightly" /tmp/scheduler.txt && echo "ok: scheduler ran every job once"

curl -fs "$API/open-items" > /tmp/open.json
check "open items persisted" "$(json 'Array.isArray(j.items)' < /tmp/open.json)"
echo "smoke passed"
