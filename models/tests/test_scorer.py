import numpy as np

from surveil_models.scorer import fit_map, weighted_log_loss


def simulate(n, beta, seed=0):
    rng = np.random.default_rng(seed)
    X = np.column_stack([np.ones(n), rng.integers(0, 2, size=(n, len(beta) - 1))]).astype(float)
    p = 1 / (1 + np.exp(-(X @ beta)))
    y = (rng.random(n) < p).astype(float)
    return X, y


def test_recovers_true_weights_with_plenty_of_data():
    beta = np.array([-2.0, 2.5, -1.0, 0.0])
    X, y = simulate(40_000, beta)
    mu = np.zeros(4)
    est, cov = fit_map(X, y, np.ones(len(y)), mu, np.full(4, 10.0))
    assert np.allclose(est, beta, atol=0.12)
    # the reported uncertainty should match the actual error scale
    assert np.all(np.sqrt(np.diag(cov)) < 0.1)


def test_no_verdicts_means_the_analysts_weights():
    mu = np.array([-3.0, 2.0, 1.0])
    sd = np.array([2.0, 1.0, 1.0])
    X = np.zeros((0, 3))
    est, cov = fit_map(X, np.zeros(0), np.zeros(0), mu, sd)
    assert np.allclose(est, mu)
    assert np.allclose(np.diag(cov), sd**2)


def test_prior_pulls_thin_evidence_toward_the_analyst_weight():
    # A rule fired on 6 cases and 1 was confirmed. The prior (analysts said +2)
    # keeps the weight from collapsing all the way to the empirical log-odds.
    X = np.column_stack([np.ones(6), np.ones(6)])
    y = np.array([1, 0, 0, 0, 0, 0], dtype=float)
    mu = np.array([0.0, 2.0])
    est, cov = fit_map(X, y, np.ones(6), mu, np.array([0.5, 1.0]))
    empirical = np.log(1 / 5)
    assert empirical < est.sum() < 2.0
    assert np.sqrt(cov[1, 1]) > 0.5  # still wide: six verdicts prove little


def test_sampling_weights_count_like_repeated_rows():
    X, y = simulate(2_000, np.array([-1.0, 1.5]), seed=3)
    w = np.where(y == 0, 4.0, 1.0)
    rep_X = np.vstack([X[y == 1]] + [X[y == 0]] * 4)
    rep_y = np.concatenate([y[y == 1]] + [y[y == 0]] * 4)
    mu, sd = np.zeros(2), np.full(2, 5.0)
    a, _ = fit_map(X, y, w, mu, sd)
    b, _ = fit_map(rep_X, rep_y, np.ones(len(rep_y)), mu, sd)
    assert np.allclose(a, b, atol=1e-6)
    assert weighted_log_loss(X, y, w, a) > 0
