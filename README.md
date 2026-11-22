# linked-account-surveillance-engine

A surveillance engine that runs by itself on a live derivatives venue. As events stream in it keeps every account's state, and every linked group's state, current within seconds. It scores each account from rules the analysts write, as a probability with an 80% interval, and links accounts that one person runs. It flags accounts that break pattern where no rule applies, and decides what is worth an analyst's time under a daily budget. It grades its own calls against verdicts and a weekly audit, refits itself, and promotes a new model only after the new one beats the old in shadow. Each morning an LLM agent writes the report, unattended, and every number in that report is checked against the data before anyone reads it.

This is a reference implementation of the architecture behind a platform I built for a mid-sized crypto derivatives exchange. The production build is under NDA, so a few integrations are abstracted behind adapters (the Kinesis streams, ECS and EventBridge scheduling, Bedrock, the analysts' case queue). It runs on synthetic data, and every company, place, person, phone number and figure in it is made up.

![ci](https://github.com/AlexKurinets/linked-account-surveillance-engine/actions/workflows/ci.yml/badge.svg)

## Architecture

```mermaid
flowchart LR
  subgraph streams[Streams]
    EV[orders, fills, transfers, sessions]
    PX[index prices]
  end
  EV --> C[Stream consumer<br/>src/engine/engine.ts]
  PX --> C
  C -->|state and cursor in one commit| PG[(Postgres)]
  C --> SC[Rules into Bayesian scorer<br/>src/engine/scoring.ts]
  C --> IF[Isolation forest<br/>src/engine/anomaly.ts]
  C --> LE[Link evidence per event<br/>src/linking/evidence.ts]
  CO[Co-activity batch, Python<br/>models/.../coactivity.py] --> PG
  LE --> PG
  PG --> LK[Linker: three families,<br/>size-capped union-find]
  LK -->|clusters| C
  SC --> AD[Alert decision<br/>budget, anomaly lane, cooldowns]
  IF --> AD
  AD --> AN[Analysts]
  AN -->|verdicts, weekly audit| CARD[Scorecard<br/>src/outcomes/scorecard.ts]
  CARD --> FIT[Nightly refit, Python<br/>models/.../scorer.py]
  FIT -->|challenger| SH[Shadow, then promote or retire<br/>src/outcomes/promote.ts]
  SH -->|champion| SC
  SCHED[Scheduler, 06:00] --> AG[Report agent<br/>src/agent/]
  AG <-->|six typed tools| PG
  AG --> CHK[Code checks] --> REP[Morning report<br/>or template and a page]
```

Everything online is TypeScript on Node. Python does the modelling: the co-activity batch, the isolation forest and the Bayesian refit. Each writes into Postgres, and the TypeScript side reads what it writes. In production the streams arrived on Kinesis and the jobs ran as ECS tasks on EventBridge schedules. Here the streams land in Postgres and the consumer tails them by id, woken by `NOTIFY`, and a scheduler process runs the jobs.

## Design decisions

**State is decayed counters, committed together with the cursor.** Each account's features are exponentially decayed counters with 60-minute and 24-hour half-lives (`src/engine/state.ts`), so an event costs one update rather than a scan over a time window. The consumer keeps state in memory and writes changed accounts, changed clusters, link evidence, alerts and its own stream position in one transaction per batch (`Engine.flush` in `src/engine/engine.ts`). A crash replays at most the batch that didn't commit. `test/engine.test.ts` crashes and restarts the consumer every two hours of event time and checks that the final state, evidence and alerts are identical to an uninterrupted run. That test caught a real gap: the recent-session windows behind IP coincidence and handoffs lived only in memory, so a restart lost any coincidence that straddled it. They are now rebuilt from the stream on start-up (`EvidenceTracker.warm`).

**The clock is event time everywhere.** Nothing reads the wall clock to decide anything, so replaying history produces exactly the state that living through it did. `node dist/cli.js replay` runs the seeded fortnight through the same consumer, linker, outcome jobs and report agent that run live. It's how every change here was tested, and how changes were tested in production.

**Linking scores pairs first and clusters second, and a link needs two kinds of evidence.** Evidence falls into three families (`src/linking/families.ts`), and each family on its own has an innocent explanation. A household shares a laptop, strangers on one mobile carrier share an IP, and market makers trade with each other all day.

- *Identity*: a shared device or payout address, weighted `log(N / k)` where k is the number of accounts sharing it, and ignored once more than 25 accounts share it. An IP counts only when two accounts start sessions on it within 10 minutes of each other.
- *Timing*: shared active minutes beyond chance, and session handoffs, where one account ends a session and another starts on the same device or IP within two minutes, three or more times. Shared minutes come from `models/surveil_models/coactivity.py`. It builds a sparse accounts-by-minutes matrix of each account's own actions, drops minutes when unusually many accounts are active (the way a search engine drops stop words), and gets every pair's count from one product, `A @ A.T`. The expected count is stratified by hour of day, because two people in the same time zone are active in the same hours without knowing each other. The Poisson tail cut-off is Bonferroni-scaled for the number of pairs tested.
- *Money*: fills between the two accounts, weighted up when they print far from the index.

Union-find then joins links strongest first (`src/linking/cluster.ts`). A merge that would push a cluster past ten accounts is refused and written to `link_reviews` for an analyst, which stops one shared computer from chaining strangers together.

**Analysts write rules; the model learns how much to trust them.** Rules are JSON conditions on features (`config/rules.json`), and analysts never write code. Each rule's firing is an input to a Bayesian logistic regression (`models/surveil_models/scorer.py`), next to the forest's anomaly rarity and the account's link features. Each weight's prior is centred on the analysts' own starting weight, so on day one the model is exactly their judgement (`analystModel` in `src/engine/scoring.ts`). The Laplace approximation gives a covariance matrix, and that is where "how sure" comes from. Every score carries an 80% interval, and a rule with few verdicts behind it gives a wide one.

**The forest is trained in Python and scored in TypeScript, and the two agree to 1e-9.** `models/surveil_models/anomaly.py` exports each fitted scikit-learn tree as arrays. `src/engine/anomaly.ts` walks them, comparing in 32-bit floats because scikit-learn casts inputs to float32 before it walks its trees. `test/units.test.ts` checks the TypeScript scores against a fixture of scikit-learn's own scores, and `models/tests/test_anomaly.py` checks the fixture is current. The scorer is fed the score's rarity (`-log10` of the share of accounts scoring higher) rather than the raw score, which lives in a narrow band. The forest is trained only on accounts not already confirmed, so novelty is measured against accounts not yet known to be bad.

**What is worth an alert.** Analysts can work about 40 alerts a day (`config/engine.json`). Each night tomorrow's threshold is set at the probability that would have produced 40 a day over the last seven days, counting only accounts that aren't already in case management, with a floor of 0.4 so a quiet week doesn't lower the bar to noise. A hard cap holds the day to 40 even when scores shift. Within a day the cap is first come, first served, which is the price of deciding in real time. Five extra slots a day go to accounts that break pattern beyond the top 0.3% of forest scores without tripping a rule. Without those slots the scorer would never see a verdict on what no rule covers, and could never learn the forest's weight. Confirmed accounts never alert again. An account awaiting a verdict waits for it, a rejected account stays quiet for seven days unless its probability rises by 0.15, and a cluster gets one alert a day (`src/engine/alerts.ts`).

**Checking itself, and learning only what survives a shadow period.** Every alert is stored with the model version, the probability, the threshold and the full input vector. Verdicts land two to 20 hours later. Verdicts on alerts only measure precision, so every account also has a weekly audit slot. If it was active and not alerted that week, it is sampled with probability 3%, or 30% just under the threshold, and weighted by the inverse of that probability (`src/outcomes/analyst.ts`). The scorecard estimates recall from those weights with a bootstrap interval, and compares stated probability with confirmed rate in ten confidence bands (`src/outcomes/scorecard.ts`). A nightly refit never goes straight live. It scores in shadow beside the champion and is promoted only if, on cases labelled during the shadow period, its log loss is lower and its precision at the budget is no worse (`src/outcomes/promote.ts`).

**The report agent runs unattended, and plain code checks its work.** `src/agent/report.ts` runs a Messages API tool loop with six typed, strict tools (`src/agent/tools.ts`). Five are read-only: the scorecard, the day's alerts, a cluster lookup, model changes and open items. The sixth stages updates to the agent's memory, a table of open items keyed by cluster, link review or rule. Tools return totals and percentages already computed, because in production the model's own arithmetic caused most failed checks. Each draft must pass these checks (`src/agent/validate.ts`):

- it matches the schema
- every number in it appears in a tool result from that run
- every account, cluster and alert ID exists
- every item open at the start is carried or closed with a reason
- the staged memory updates agree with the report

The number check proves that each number came from this run's tool results. It does not prove the number is attached to the right noun, so a misattributed figure that happens to exist elsewhere in the results gets through. That gap is why the tools return totals instead of leaving sums to the model. A failed draft goes back once with the errors listed. A second failure publishes a template report built from the same tool results and writes a page. Memory commits only with a published report. `ClaudeReportModel` (`src/agent/model.ts`) calls `claude-opus-5-5` with server-side refusal fallbacks; production ran the same loop on Bedrock. By default the stack uses `ScriptedReportModel`, a deterministic stand-in that plays the model's part through the same loop, so everything runs without an API key.

## What the replay shows

These numbers come from one `docker compose up` on my machine: 3,000 accounts and 14 days of history ending the day the stack started. `node dist/cli.js summary` prints the same tables from the database. They are synthetic and cleaner than production's in places, so read them as evidence that the mechanisms work, not as a forecast.

| Day | Champion | Threshold | Alerts | Precision | Recall estimate (90% interval) |
|---|---|---|---|---|---|
| 1 | analyst-v1 | 0.50 | 6 | 33% | 6% (1% to 100%) |
| 2 | analyst-v1 | 0.40 | 45 | 18% | 23% (8% to 100%) |
| 3 | analyst-v1 | 0.48 | 45 | 16% | 32% (14% to 100%) |
| 4 | analyst-v1 | 0.55 | 45 | 20% | 41% (18% to 100%) |
| 5 | first promoted refit | 0.40 | 22 | 59% | 32% (18% to 100%) |
| 6 | | 0.40 | 18 | 56% | 40% (22% to 94%) |
| 7 | second promoted refit | 0.40 | 10 | 80% | 33% (20% to 62%) |
| 8 | | 0.40 | 13 | 85% | 46% (27% to 95%) |
| 9 | third promoted refit | 0.40 | 29 | 100% | 49% (29% to 91%) |
| 10 | | 0.40 | 23 | 87% | 45% (29% to 87%) |
| 11 | fourth promoted refit | 0.40 | 26 | 96% | 49% (32% to 75%) |
| 12 | | 0.40 | 20 | 75% | 60% (42% to 92%) |
| 13 | fifth promoted refit | 0.40 | 13 | 92% | 60% (42% to 92%) |
| 14 | sixth promoted refit | 0.40 | 10 | 40% | 74% (53% to 97%) |

For the first four days the champion is the analysts' own weights. They put 3.0 on "three or more devices in a week", and in this world, as in production, that mostly describes ordinary traders with a phone, a laptop and a work machine. The 40-alert cap fills with them, plus up to five anomaly-lane alerts, and precision runs between 16% and 33%. The first refit to survive its shadow period goes live on day 5, having cut that weight hard, and precision from then on runs between 56% and 100%. Day 14's 40% is on ten alerts. Over the whole fortnight:

| Scored by | Alerts | Confirmed | Precision |
|---|---|---|---|
| the analysts' starting weights | 141 | 26 | 18% |
| refitted models, after shadow promotion | 184 | 147 | 80% |

The recall estimate climbs as the weekly audit accumulates, and its interval stays wide. On the first days it means almost nothing, which is why the scorecard never shows the point estimate without its interval. The synthetic ground truth shows what the estimate can't:

| Bad actors (synthetic truth) | Accounts | Confirmed through an alert | Of those, through the anomaly lane |
|---|---|---|---|
| rings (accounts run by one operator) | 138 | 130 | 23 |
| mules (deposit, withdraw within the hour) | 40 | 30 | 6 |
| spoofers (order floods, no rule covers them) | 25 | 9 | 9 |

Every spoofer that was caught came through the five daily anomaly slots, and 16 of the 25 were never caught. They are under 1% of accounts, and an audit that samples 3% of quiet accounts a week rarely lands on one, so the recall estimate can't see that hole. That is the honest limit of estimating recall from an audit sample, and the reason I always reported the interval.

Linking, scored pairwise against the synthetic truth, with the same evidence clustered under weaker settings (`node dist/cli.js evaluate`):

| Linking variant | Pair precision | Pair recall | Clusters | Largest | Household pairs linked | Market-maker pairs linked |
|---|---|---|---|---|---|---|
| as configured | 100% | 84% | 35 | 6 | 0 | 0 |
| no rarity weighting or identifier cap | 100% | 84% | 35 | 6 | 0 | 0 |
| one evidence family is enough | 75% | 85% | 95 | 6 | 50 | 6 |
| one family, no rarity weighting | 46% | 85% | 99 | 10 | 50 | 6 |
| naive: no rarity, one family, no size cap | 22% | 85% | 96 | 34 | 50 | 6 |

The two-family rule does most of the work. Rarity weighting matters once that rule is gone, because carrier NAT addresses and the shared office computer start linking strangers. The size cap is what stops the naive variant from building a 34-account cluster. Production link precision was about 90%, not 100%; the synthetic rings are tidier than real ones. The 16% of ring pairs left unlinked are mostly rings that never trade with each other and use separate devices over a VPN, so they show only one family of evidence.

At the feed's natural rate (about one event a second plus 20 index ticks a second), the live consumer's median per-batch p95 lag was 167 ms. Most of that is the feed's own quarter-second emission cadence. Under load (`node dist/cli.js live --mm-only --mm-rate 200`, about 394 events a second for 60 seconds) it committed 256 batches with a median per-batch p95 of 11 ms, a 95th percentile of 116 ms and a worst batch of 248 ms. That was Docker Desktop on Windows. Market-maker events skip retail scoring, so the load test exercises the state, evidence and commit path, not the scorer.

Three things didn't work the first time while building this, and each now has a test:

- **The budget threshold counted accounts already in case management.** It stayed near 0.8 and starved recall.
- **Co-activity divided by the full seven-day window while the stream was younger than the window.** That understated chance by about 30% and linked market makers in the first week (`test_a_stream_younger_than_the_window_does_not_inflate_surprise`).
- **The restart window gap,** described above.

## Running it

```bash
docker compose up -d --build --wait   # first start seeds 14 days for 3,000 accounts and replays them
scripts/smoke.sh                      # walks every command below and checks the answers
```

The first start takes a few minutes, because the engine seeds the synthetic history and replays it through the whole system before it switches to consuming the live feed. Host ports default to 5556 (Postgres) and 8270 (API); override them with `POSTGRES_PORT` and `API_PORT`. `SURV_ACCOUNTS` and `SURV_DAYS` shrink the world for a quicker start (CI uses 1,000 and 5).

```bash
curl localhost:8270/scorecard              # per day: alerts, precision, recall estimate and interval, bands, per-rule precision
curl localhost:8270/clusters               # linked clusters with their state
curl localhost:8270/clusters/C10023        # one cluster and the evidence behind every link
curl "localhost:8270/alerts?day=2026-03-14" # alerts with probability, interval and reasons
curl localhost:8270/reports/latest         # the morning report, as JSON and markdown
curl localhost:8270/open-items             # the report agent's memory
curl localhost:8270/models                 # champions, challengers and each shadow comparison
curl localhost:8270/metrics/freshness      # live consumer: event-to-commit lag over the last 15 minutes
curl localhost:8270/linking/evaluation     # published clusters against the synthetic ground truth

docker compose exec engine node dist/cli.js evaluate                       # linking precision and recall, plus the ablation table
docker compose exec engine node dist/cli.js report --day 2026-03-14 --faults 1   # watch a bad draft get sent back and fixed
docker compose exec scheduler node dist/cli.js scheduler --once            # run every scheduled job now
```

Cluster ids and dates depend on the day you start the stack; take real ones from `/clusters` and `/scorecard`. To have Claude write the reports instead of the scripted stand-in, set `SURV_REPORT_LLM=claude` and `ANTHROPIC_API_KEY` before `docker compose up`, or pass `--llm claude` to `report`.

Without Docker (Node 22+, Python 3.12+, Postgres 16):

```bash
npm ci && npm run build
python -m venv models/.venv && models/.venv/bin/pip install -r models/requirements.txt
export DATABASE_URL=postgres://surv:surv@localhost:5432/surv SURV_PYTHON=models/.venv/bin/python
node dist/cli.js seed --days 14 && node dist/cli.js replay
node dist/cli.js api --port 8270
```

## Tests

```bash
cd models && python -m pytest -q tests     # 13: scorer recovery and priors, sklearn parity, co-activity false-positive control
npx vitest run                             # 33: state, scoring, linking, restart determinism, the replayed pipeline, the report agent
```

The TypeScript tests run against a real Postgres (`TEST_DATABASE_URL`, default `postgres://surv:surv@localhost:5546/surv_test`), and the pipeline test drives the Python worker, so `SURV_PYTHON` must point at an interpreter with `models/requirements.txt` installed. CI runs both suites against a `postgres:16` service, then brings up the Compose stack and runs `scripts/smoke.sh`.

## Layout

```
config/            rules.json (the analysts' rules), engine.json (every threshold and window)
db/schema.sql      streams, state, evidence, links, models, decisions, scorecard, memory, reports
src/engine/        consumer, decayed state, index prices, scoring, forest evaluation, alert rules
src/linking/       per-event evidence, family scoring, union-find, evaluation and ablation
src/outcomes/      simulated verdicts and audit, scorecard, shadow promotion, budget threshold
src/agent/         tools, checks, Claude and scripted models, the unattended run
src/sim/           synthetic venue: rings, households, carrier NAT, market makers, mules, spoofers
src/jobs.ts        replay, the nightly sequence, live consumer, scheduler
models/            Python: co-activity, isolation forest export, Bayesian refit
test/, models/tests/
```

## What is deliberately left out

The Kinesis, ECS, EventBridge and Bedrock adapters: the interfaces they sit behind are here (`Engine.step`, `runScheduler`, `ReportModel`), and the wiring to AWS is not. The analysts are simulated from the synthetic ground truth, with label noise and a delay, so the case queue and its UI are absent. Automatic actions are not built. The per-band confirmed rates in the scorecard are what I would use to set their limits. The API has no authentication. Synthetic figures are cleaner than production ones, because the synthetic world has a fixed cast of bad actors with behaviours I wrote down; the table above should be read as evidence that the mechanisms work, not as a forecast.

MIT, Alex Kurinets
