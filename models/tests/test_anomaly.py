import json
from pathlib import Path

import numpy as np
from sklearn.ensemble import IsolationForest

from surveil_models.anomaly import export, score_exported
from surveil_models.parity import FIXTURE, build_fixture

ROOT = Path(__file__).resolve().parents[2]


def test_exported_trees_score_exactly_like_sklearn():
    rng = np.random.default_rng(1)
    X = np.vstack([rng.normal(size=(500, 6)), rng.normal(loc=4, size=(10, 6))])
    model = IsolationForest(n_estimators=100, max_samples=128, random_state=0).fit(X)
    exported = export(model, [f"f{i}" for i in range(6)], X)
    ours = np.array([score_exported(exported, list(x)) for x in X[:200]])
    theirs = -model.score_samples(X[:200])
    assert np.max(np.abs(ours - theirs)) < 1e-12


def test_feature_subsampling_is_mapped_back():
    rng = np.random.default_rng(2)
    X = rng.normal(size=(400, 8))
    model = IsolationForest(n_estimators=50, max_samples=64, max_features=0.5, random_state=4).fit(X)
    exported = export(model, [f"f{i}" for i in range(8)], X)
    ours = np.array([score_exported(exported, list(x)) for x in X[:100]])
    assert np.max(np.abs(ours + model.score_samples(X[:100]))) < 1e-12


def test_values_on_a_threshold_follow_sklearns_float32_cast():
    # A value that only differs from a split threshold past float32 precision must
    # go the same way it does inside sklearn, which casts inputs to float32.
    rng = np.random.default_rng(5)
    X = rng.normal(size=(300, 3))
    model = IsolationForest(n_estimators=20, max_samples=64, random_state=1).fit(X)
    exported = export(model, ["a", "b", "c"], X)
    t = exported["trees"][0]
    node = 0
    probe = np.array(X[0], dtype=float)
    probe[t["feature"][node]] = t["threshold"][node] + 1e-9
    assert abs(score_exported(exported, list(probe)) + model.score_samples(probe[None, :])[0]) < 1e-12


def test_committed_fixture_is_current():
    """The TypeScript parity test reads this fixture; it must be exactly what sklearn produces."""
    committed = json.loads((ROOT / FIXTURE).read_text())
    fresh = build_fixture()
    # trees must be identical; scores may differ in the last bits across platforms' libm
    assert np.allclose(committed["expected"], fresh["expected"], rtol=0, atol=1e-12)
    assert committed["model"]["trees"][0] == fresh["model"]["trees"][0]
