"""Isolation forest: trained here with scikit-learn, scored in TypeScript.

The export walks each fitted tree and writes its arrays as JSON. Feature
indices are mapped back to the model's own feature list, so the TypeScript
evaluator (src/engine/anomaly.ts) needs no knowledge of scikit-learn's feature
subsampling. `score_exported` is a line-for-line Python twin of that evaluator,
used by the parity test.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import IsolationForest

EULER = 0.5772156649015329


def average_path_length(n: float) -> float:
    if n <= 1:
        return 0.0
    if n == 2:
        return 1.0
    return 2.0 * (math.log(n - 1.0) + EULER) - 2.0 * (n - 1.0) / n


def train(X: np.ndarray, n_trees: int, max_samples: int, seed: int = 0) -> IsolationForest:
    model = IsolationForest(n_estimators=n_trees, max_samples=min(max_samples, len(X)), random_state=seed)
    model.fit(X)
    return model


def export(model: IsolationForest, feature_names: list[str], X: np.ndarray) -> dict:
    n_features = X.shape[1]
    full = model._max_features == n_features  # sklearn passes X unsubsampled in this case
    trees = []
    for est, feats in zip(model.estimators_, model.estimators_features_):
        t = est.tree_
        feature = [int(f) if full or f < 0 else int(feats[f]) for f in t.feature]
        trees.append(
            {
                "feature": [f if f >= 0 else -1 for f in feature],
                "threshold": [float(v) for v in t.threshold],
                "left": [int(v) for v in t.children_left],
                "right": [int(v) for v in t.children_right],
                "n": [int(v) for v in t.n_node_samples],
            }
        )
    # Distribution of training scores, so the engine can turn a score into a rarity.
    scores = -model.score_samples(X)
    quantiles = np.quantile(scores, np.linspace(0.0, 1.0, 1001))
    median = np.median(X, axis=0)
    mad = np.median(np.abs(X - median), axis=0)
    return {
        "features": feature_names,
        "max_samples": int(model._max_samples),
        "trees": trees,
        "median": [float(v) for v in median],
        "mad": [float(v) for v in mad],
        "score_quantiles": [float(v) for v in quantiles],
    }


def score_exported(exported: dict, x: list[float]) -> float:
    """Same algorithm as anomalyScore() in src/engine/anomaly.ts."""
    total = 0.0
    for t in exported["trees"]:
        node, depth = 0, 0
        while t["left"][node] != -1:
            v = float(np.float32(x[t["feature"][node]]))
            node = t["left"][node] if v <= t["threshold"][node] else t["right"][node]
            depth += 1
        total += depth + average_path_length(t["n"][node])
    return 2.0 ** (-total / (len(exported["trees"]) * average_path_length(exported["max_samples"])))


def run(conn, as_of_seconds: float, engine_cfg: dict) -> dict:
    cfg = engine_cfg["anomaly"]
    names = cfg["features"]
    rows = conn.execute(
        """SELECT s.features FROM account_state s JOIN accounts a USING (account_id)
           WHERE a.tier = 'retail' AND s.event_time > to_timestamp(%s) AND s.event_time <= to_timestamp(%s)
             -- novelty is measured against accounts not already known to be bad
             AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.account_id = s.account_id
                             AND d.verdict = 'confirmed' AND d.verdict_at <= to_timestamp(%s))""",
        (as_of_seconds - cfg["train_window_days"] * 86400, as_of_seconds, as_of_seconds),
    ).fetchall()
    if len(rows) < 50:
        return {"skipped": f"only {len(rows)} active accounts"}
    X = np.array([[float(r[0].get(n, 0.0)) for n in names] for r in rows])
    model = train(X, cfg["n_trees"], cfg["max_samples"], seed=int(as_of_seconds) % (2**31))
    params = export(model, names, X)
    version = "anomaly-" + datetime.fromtimestamp(as_of_seconds, tz=timezone.utc).strftime("%Y%m%dT%H%M")
    if conn.execute("SELECT 1 FROM models WHERE version = %s", (version,)).fetchone():
        return {"skipped": f"{version} already exists"}
    with conn.transaction():
        conn.execute("UPDATE models SET status = 'retired', decided_at = to_timestamp(%s) WHERE kind = 'anomaly' AND status = 'champion'", (as_of_seconds,))
        conn.execute(
            """INSERT INTO models (version, kind, status, params, metrics, trained_through, created_at, decided_at)
               VALUES (%s, 'anomaly', 'champion', %s, %s, to_timestamp(%s), to_timestamp(%s), to_timestamp(%s))
               ON CONFLICT (version) DO NOTHING""",
            (version, json.dumps(params), json.dumps({"accounts": len(X)}), as_of_seconds, as_of_seconds, as_of_seconds),
        )
    return {"version": version, "accounts": len(X)}
