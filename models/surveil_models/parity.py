"""Builds the cross-language parity fixture for the isolation forest.

    python -m surveil_models.parity      # rewrites test/fixtures/iforest_parity.json

The TypeScript test (test/anomaly.test.ts) scores the same inputs from the
exported trees and must match scikit-learn's own scores to 1e-9.
"""

import json
from pathlib import Path

import numpy as np

from .anomaly import export, train

FIXTURE = "test/fixtures/iforest_parity.json"
FEATURES = ["log_orders_1h", "cancel_ratio_1h", "log_fill_notional_24h", "off_index_bps_24h"]


def build_fixture() -> dict:
    rng = np.random.default_rng(42)
    normal = np.column_stack([
        rng.normal(1.5, 0.5, 600),
        rng.uniform(0.2, 0.6, 600),
        rng.normal(7.5, 1.0, 600),
        np.abs(rng.normal(0, 3, 600)),
    ])
    odd = np.column_stack([rng.normal(4.0, 0.3, 12), rng.uniform(0.9, 1.0, 12), rng.normal(6.0, 0.5, 12), np.abs(rng.normal(0, 3, 12))])
    X = np.vstack([normal, odd])
    model = train(X, n_trees=100, max_samples=256, seed=11)
    probes = np.vstack([X[::7], odd])
    return {
        "model": {"version": "parity", **export(model, FEATURES, X)},
        "inputs": [[float(v) for v in row] for row in probes],
        "expected": [float(v) for v in -model.score_samples(probes)],
    }


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    (root / FIXTURE).parent.mkdir(parents=True, exist_ok=True)
    (root / FIXTURE).write_text(json.dumps(build_fixture()))
    print("wrote", FIXTURE)
