"""Shared-minute co-activity between every pair of accounts, from timestamps alone.

Each account's own actions (orders, deposits, withdrawals, session starts) mark
the minutes it was active over a rolling window. Fills are left out on purpose:
a trade between two accounts already counts as money evidence and shouldn't be
counted again as timing.

1. Minutes when unusually many accounts are active (market-wide bursts) are
   dropped, the way a search engine drops stop words.
2. The sparse accounts-by-minutes matrix A gives every pair's shared-minute
   count in one product, A @ A.T.
3. Each count is compared with what chance predicts. People in the same time
   zone are active in the same hours, so the expectation is stratified by hour
   of day: lambda_ab = sum_h n_a,h * n_b,h / T_h, where n_a,h is a's active
   minutes in hour-of-day h and T_h the minutes available in that hour.
4. A Poisson tail probability turns (k, lambda) into a surprise score,
   -log10 P(X >= k), and the cut-off is Bonferroni-scaled for the number of
   pairs tested: with 4.5 million pairs, a 1-in-10,000 cut-off would flag
   about 450 pairs by luck alone.
5. The expectation uses only the part of the window that has data.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.stats import poisson

OWN_ACTIONS = ("order", "deposit", "withdrawal", "session_start")


@dataclass
class CoactivityResult:
    pairs: list[dict]
    accounts_tested: int
    kept_minutes: int
    stop_minutes: int
    cut: float


def coactivity(account_ids: np.ndarray, ts_seconds: np.ndarray, window_end: float, cfg: dict) -> CoactivityResult:
    """account_ids: array of str; ts_seconds: epoch seconds of each own action."""
    window = cfg["window_days"] * 86400
    mask = (ts_seconds > window_end - window) & (ts_seconds <= window_end)
    acc, ts = account_ids[mask], ts_seconds[mask]
    if len(acc) == 0:
        return CoactivityResult([], 0, 0, 0, math.inf)

    names, a_idx = np.unique(acc, return_inverse=True)
    minute = np.floor(ts / 60).astype(np.int64)
    cells = np.unique(np.stack([a_idx, minute], axis=1), axis=0)
    a_idx, minute = cells[:, 0], cells[:, 1]

    # 1. stop-word minutes
    m_vals, m_inv, m_counts = np.unique(minute, return_inverse=True, return_counts=True)
    cut_count = np.quantile(m_counts, cfg["stop_minute_quantile"])
    stop = m_counts > cut_count
    keep = ~stop[m_inv]
    a_idx, minute, col = a_idx[keep], minute[keep], m_inv[keep]
    # re-index kept minutes to compact columns
    kept_vals, col = np.unique(col, return_inverse=True)

    n_acc = len(names)
    A = sparse.csr_matrix((np.ones(len(a_idx), dtype=np.int32), (a_idx, col)), shape=(n_acc, len(kept_vals)))
    # 2. shared minutes for every pair in one product
    C = sparse.triu(A @ A.T, k=1).tocoo()
    sel = C.data >= cfg["min_shared_minutes"]
    ia, ib, k = C.row[sel], C.col[sel], C.data[sel].astype(float)

    # 3. hour-of-day stratified expectation
    hour = ((minute // 60) % 24).astype(np.int64)
    N = np.zeros((n_acc, 24))
    np.add.at(N, (a_idx, hour), 1.0)
    # Expected counts use only the span that actually has data. Dividing by the full
    # window when the stream is younger than the window (the first week after go-live,
    # or a short replay) understates chance and makes busy, independent accounts look
    # coordinated; the first version of this linked market makers that way.
    first_minute = max(int((window_end - window) // 60) + 1, int(minute.min()) if len(minute) else 0)
    window_minutes = np.arange(first_minute, int(window_end // 60) + 1)
    T = np.bincount((window_minutes // 60) % 24, minlength=24).astype(float)
    stop_minutes = m_vals[stop]
    T -= np.bincount((stop_minutes // 60) % 24, minlength=24)
    T = np.maximum(T, 1.0)
    lam = np.einsum("ph,ph->p", N[ia], N[ib] / T)

    # 4. Poisson tail, Bonferroni-scaled cut-off
    surprise = -poisson.logsf(k - 1, np.maximum(lam, 1e-12)) / math.log(10)
    m_pairs = n_acc * (n_acc - 1) / 2
    cut = -math.log10(cfg["alpha"] / max(m_pairs, 1))
    out = []
    for x, y, kk, ll, s in zip(ia, ib, k, lam, surprise):
        if s < cut / 2:
            continue
        a, b = sorted((str(names[x]), str(names[y])))
        out.append({"a": a, "b": b, "surprise": float(s), "shared_minutes": int(kk), "expected": float(ll)})
    return CoactivityResult(out, n_acc, len(kept_vals), int(stop.sum()), cut)


def run(conn, as_of_seconds: float, cfg: dict) -> dict:
    window = cfg["window_days"] * 86400
    rows = conn.execute(
        "SELECT account_id, extract(epoch FROM ts) FROM events WHERE kind = ANY(%s) AND ts > to_timestamp(%s) AND ts <= to_timestamp(%s)",
        (list(OWN_ACTIONS), as_of_seconds - window, as_of_seconds),
    ).fetchall()
    if rows:
        acc = np.array([r[0] for r in rows])
        ts = np.array([float(r[1]) for r in rows])
    else:
        acc, ts = np.array([], dtype=str), np.array([], dtype=float)
    res = coactivity(acc, ts, as_of_seconds, cfg)
    with conn.transaction():
        conn.execute("DELETE FROM pair_evidence WHERE kind = 'coactivity'")
        if res.pairs:
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO pair_evidence (a, b, kind, value, detail, updated_at) VALUES (%s, %s, 'coactivity', %s, %s, to_timestamp(%s))",
                    [
                        (
                            p["a"],
                            p["b"],
                            p["surprise"],
                            _json({"cut": res.cut, "shared_minutes": p["shared_minutes"], "expected": p["expected"]}),
                            as_of_seconds,
                        )
                        for p in res.pairs
                    ],
                )
    return {
        "pairs_written": len(res.pairs),
        "above_cut": sum(1 for p in res.pairs if p["surprise"] >= res.cut),
        "accounts_tested": res.accounts_tested,
        "stop_minutes": res.stop_minutes,
        "cut": res.cut,
    }


def _json(d: dict) -> str:
    import json

    return json.dumps(d)
