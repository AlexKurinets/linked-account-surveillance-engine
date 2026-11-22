"""Bayesian logistic regression over the analysts' rules, refit nightly on verdicts.

Inputs are the rule firings (0/1), the isolation forest's anomaly score and the
account's link features. Each weight has a Gaussian prior centred on the
analysts' own starting weight, so with no verdicts the model is exactly their
judgement, and with verdicts a weight moves only as far as the evidence
justifies. The MAP estimate comes from Newton's method, and the inverse Hessian
at the MAP (the Laplace approximation) is the covariance the TypeScript side
uses to put an 80% interval around every probability.

Training rows are alerts (weight 1) plus audit samples of non-alerted accounts,
weighted by 1 / sampling probability. Alerted accounts are observed with
probability 1 and the rest with probability pi, so the weighted sample stands
in for the whole population and the fit is not biased toward what was alerted.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np

from .config import prior, score_feature_names


def fit_map(X: np.ndarray, y: np.ndarray, w: np.ndarray, mu: np.ndarray, sd: np.ndarray, iters: int = 50):
    """Newton's method on the negative log posterior. Returns (beta, covariance)."""
    beta = mu.astype(float).copy()
    prec = 1.0 / sd**2
    for _ in range(iters):
        eta = X @ beta
        p = 1.0 / (1.0 + np.exp(-eta))
        grad = X.T @ (w * (p - y)) + prec * (beta - mu)
        H = (X * (w * p * (1 - p))[:, None]).T @ X + np.diag(prec)
        step = np.linalg.solve(H, grad)
        beta -= step
        if np.max(np.abs(step)) < 1e-9:
            break
    eta = X @ beta
    p = 1.0 / (1.0 + np.exp(-eta))
    H = (X * (w * p * (1 - p))[:, None]).T @ X + np.diag(prec)
    cov = np.linalg.inv(H)
    return beta, (cov + cov.T) / 2


def weighted_log_loss(X, y, w, beta) -> float:
    p = np.clip(1.0 / (1.0 + np.exp(-(X @ beta))), 1e-9, 1 - 1e-9)
    return float(-(w * (y * np.log(p) + (1 - y) * np.log(1 - p))).sum() / w.sum())


def run(conn, as_of_seconds: float, engine_cfg: dict, rules_cfg: dict) -> dict:
    pending = conn.execute("SELECT version FROM models WHERE kind = 'score' AND status = 'challenger'").fetchone()
    if pending:
        return {"skipped": f"{pending[0]} is still in shadow"}
    rows = conn.execute(
        "SELECT x, verdict, weight FROM decisions WHERE verdict IS NOT NULL AND verdict_at <= to_timestamp(%s)",
        (as_of_seconds,),
    ).fetchall()
    if len(rows) < 30:
        return {"skipped": f"only {len(rows)} labelled cases"}
    names = score_feature_names(engine_cfg, rules_cfg)
    X = np.array([[float(r[0].get(n, 1.0 if n == "intercept" else 0.0)) for n in names] for r in rows])
    y = np.array([1.0 if r[1] == "confirmed" else 0.0 for r in rows])
    w = np.array([float(r[2]) for r in rows])
    mu, sd = prior(engine_cfg, rules_cfg)
    mu, sd = np.array(mu), np.array(sd)
    beta, cov = fit_map(X, y, w, mu, sd)
    version = "score-" + datetime.fromtimestamp(as_of_seconds, tz=timezone.utc).strftime("%Y%m%dT%H%M")
    metrics = {
        "cases": len(rows),
        "weighted_cases": float(w.sum()),
        "confirmed": int(y.sum()),
        "train_log_loss": weighted_log_loss(X, y, w, beta),
        "prior_log_loss": weighted_log_loss(X, y, w, mu),
        "shift_from_analyst_weights": {n: round(float(b - m), 3) for n, b, m in zip(names, beta, mu)},
    }
    params = {"features": names, "mean": [float(b) for b in beta], "cov": [[float(c) for c in row] for row in cov]}
    conn.execute(
        """INSERT INTO models (version, kind, status, params, metrics, trained_through, created_at)
           VALUES (%s, 'score', 'challenger', %s, %s, to_timestamp(%s), to_timestamp(%s)) ON CONFLICT (version) DO NOTHING""",
        (version, json.dumps(params), json.dumps(metrics), as_of_seconds, as_of_seconds),
    )
    conn.commit()
    return {"version": version, **{k: metrics[k] for k in ("cases", "confirmed", "train_log_loss", "prior_log_loss")}}

