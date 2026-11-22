-- Schema for the surveillance engine. Idempotent: safe to run on every start.

-- Raw streams (in production these arrive on Kinesis; here they land in Postgres
-- and the consumer tails them by id).
CREATE TABLE IF NOT EXISTS accounts (
  account_id text PRIMARY KEY,
  opened_at  timestamptz NOT NULL,
  -- designated market makers are surveilled under their own obligations, not by this engine's retail scoring
  tier       text NOT NULL DEFAULT 'retail' CHECK (tier IN ('retail','market_maker'))
);

CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL,
  account_id text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('session_start','session_end','order','cancel','fill','deposit','withdrawal')),
  payload    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);

CREATE TABLE IF NOT EXISTS index_prices (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL,
  contract text NOT NULL,
  price    double precision NOT NULL
);

-- Synthetic ground truth. Only the analyst simulator and the evaluation code
-- read this table; the engine never does.
CREATE TABLE IF NOT EXISTS sim_truth (
  account_id text PRIMARY KEY,
  role       text NOT NULL,
  group_id   text
);

-- Consumer position. Written in the same transaction as the state it produced.
CREATE TABLE IF NOT EXISTS consumer_cursor (
  consumer      text PRIMARY KEY,
  last_event_id bigint NOT NULL DEFAULT 0,
  last_price_id bigint NOT NULL DEFAULT 0,
  event_time    timestamptz
);

CREATE TABLE IF NOT EXISTS account_state (
  account_id text PRIMARY KEY,
  event_time timestamptz NOT NULL,
  state      jsonb NOT NULL,
  features   jsonb NOT NULL,
  score      jsonb
);
CREATE INDEX IF NOT EXISTS account_state_time_idx ON account_state (event_time);

CREATE TABLE IF NOT EXISTS cluster_state (
  cluster_id text PRIMARY KEY,
  event_time timestamptz NOT NULL,
  features   jsonb NOT NULL
);

-- Identifiers seen per account (device fingerprints, IPs, payout addresses).
CREATE TABLE IF NOT EXISTS identifiers (
  kind       text NOT NULL,
  value      text NOT NULL,
  account_id text NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL,
  PRIMARY KEY (kind, value, account_id)
);

-- Behavioural and money evidence between two accounts (a < b).
CREATE TABLE IF NOT EXISTS pair_evidence (
  a          text NOT NULL,
  b          text NOT NULL,
  kind       text NOT NULL,
  value      double precision NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (a, b, kind)
);

CREATE TABLE IF NOT EXISTS links (
  a        text NOT NULL,
  b        text NOT NULL,
  score    double precision NOT NULL,
  families text[] NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS clusters (
  cluster_id     text PRIMARY KEY,
  members        text[] NOT NULL,
  min_link_score double precision NOT NULL,
  first_seen     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS account_cluster (
  account_id text PRIMARY KEY,
  cluster_id text NOT NULL
);

-- Merges the size cap refused; they go to an analyst instead.
CREATE TABLE IF NOT EXISTS link_reviews (
  a          text NOT NULL,
  b          text NOT NULL,
  score      double precision NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (a, b)
);

-- Model registry: Python writes, TypeScript reads.
CREATE TABLE IF NOT EXISTS models (
  version         text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('score','anomaly')),
  status          text NOT NULL CHECK (status IN ('champion','challenger','retired')),
  params          jsonb NOT NULL,
  metrics         jsonb NOT NULL DEFAULT '{}',
  trained_through timestamptz,
  created_at      timestamptz NOT NULL,
  decided_at      timestamptz
);

CREATE TABLE IF NOT EXISTS engine_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Every alert and every audit sample, with what the engine knew at the time.
CREATE TABLE IF NOT EXISTS decisions (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL,
  day        date NOT NULL,
  account_id text NOT NULL,
  cluster_id text,
  kind       text NOT NULL CHECK (kind IN ('alert','audit')),
  x          jsonb NOT NULL,
  scores     jsonb NOT NULL,
  champion   text NOT NULL,
  p          double precision NOT NULL,
  threshold  double precision NOT NULL,
  weight     double precision NOT NULL,
  reasons    jsonb NOT NULL DEFAULT '{}',
  verdict    text CHECK (verdict IN ('confirmed','rejected')),
  verdict_at timestamptz
);
CREATE INDEX IF NOT EXISTS decisions_day_idx ON decisions (day);
CREATE INDEX IF NOT EXISTS decisions_account_idx ON decisions (account_id);

-- Highest-scoring moment per account per day, kept so the nightly threshold
-- can be recomputed under whichever model is champion.
CREATE TABLE IF NOT EXISTS daily_scores (
  account_id text NOT NULL,
  day        date NOT NULL,
  max_p      double precision NOT NULL,
  x          jsonb NOT NULL,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS engine_metrics (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL,
  mode       text NOT NULL,
  events     integer NOT NULL,
  lag_p50_ms double precision,
  lag_p95_ms double precision
);

CREATE TABLE IF NOT EXISTS scorecard_daily (
  day          date PRIMARY KEY,
  champion     text NOT NULL,
  challenger   text,
  threshold    double precision NOT NULL,
  alerts       integer NOT NULL,
  resolved     integer NOT NULL,
  confirmed    integer NOT NULL,
  precision    double precision,
  window_days  integer NOT NULL,
  recall_est   double precision,
  recall_lo    double precision,
  recall_hi    double precision,
  brier        double precision,
  bands        jsonb NOT NULL,
  by_rule      jsonb NOT NULL
);

-- Analyst decisions on clusters (simulated here).
CREATE TABLE IF NOT EXISTS cluster_actions (
  cluster_id text NOT NULL,
  day        date NOT NULL,
  action     text NOT NULL,
  note       text NOT NULL,
  PRIMARY KEY (cluster_id, day)
);

-- The report agent's memory between runs.
CREATE TABLE IF NOT EXISTS open_items (
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('open','closed')),
  opened_day    date NOT NULL,
  last_day      date NOT NULL,
  note          text NOT NULL,
  closed_reason text,
  PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS reports (
  day          date PRIMARY KEY,
  source       text NOT NULL CHECK (source IN ('agent','template')),
  attempts     integer NOT NULL,
  report       jsonb NOT NULL,
  markdown     text NOT NULL,
  check_errors jsonb NOT NULL DEFAULT '[]',
  tool_calls   integer NOT NULL,
  created_at   timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL,
  source  text NOT NULL,
  message text NOT NULL
);
