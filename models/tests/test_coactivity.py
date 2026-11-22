import numpy as np

from surveil_models.coactivity import coactivity

CFG = {"window_days": 7, "stop_minute_quantile": 0.995, "alpha": 0.01, "min_shared_minutes": 3}
END = 1_700_000_000 - (1_700_000_000 % 86400) + 7 * 86400  # a midnight


def background(rng, n_accounts=300, per_day=12):
    """Independent accounts, each active in its own random waking hours."""
    acc, ts = [], []
    for a in range(n_accounts):
        start_hour = rng.integers(0, 24)
        for day in range(7):
            k = rng.poisson(per_day)
            hours = (start_hour + rng.integers(0, 10, k)) % 24
            t = END - (7 - day) * 86400 + hours * 3600 + rng.integers(0, 3600, k)
            acc += [f"A{a:05d}"] * k
            ts += list(t)
    return acc, ts


def run(acc, ts):
    return coactivity(np.array(acc), np.array(ts, dtype=float), float(END), CFG)


def flagged(res):
    return {(p["a"], p["b"]) for p in res.pairs if p["surprise"] >= res.cut}


def test_independent_accounts_produce_no_links():
    rng = np.random.default_rng(0)
    res = run(*background(rng))
    assert flagged(res) == set()


def test_one_operator_running_two_accounts_is_found():
    rng = np.random.default_rng(1)
    acc, ts = background(rng)
    # the operator acts on both accounts within the same minute, 30 times over the week
    for i in range(30):
        t = END - 6 * 86400 + i * 4 * 3600 + 120
        acc += ["B00001", "B00002"]
        ts += [t, t + 20]
    assert flagged(run(acc, ts)) == {("B00001", "B00002")}


def test_same_time_zone_alone_is_not_evidence():
    # Two accounts that are only ever active in the same two hours each evening,
    # independently of each other. Without hour-of-day stratification they look
    # far too coincident; with it, they don't.
    rng = np.random.default_rng(2)
    acc, ts = background(rng)
    for name in ("E00001", "E00002"):
        for day in range(7):
            t = END - (7 - day) * 86400 + 20 * 3600 + rng.integers(0, 7200, 15)
            acc += [name] * 15
            ts += list(t)
    assert ("E00001", "E00002") not in flagged(run(acc, ts))


def test_a_stream_younger_than_the_window_does_not_inflate_surprise():
    # Two busy, independent accounts with only three days of history in a 7-day window.
    rng = np.random.default_rng(4)
    acc, ts = [], []
    for name in ("M00001", "M00002"):
        t = END - 3 * 86400 + np.sort(rng.choice(3 * 1440, size=1400, replace=False)) * 60 + 5
        acc += [name] * len(t)
        ts += list(t)
    a, t = background(np.random.default_rng(5))
    keep = [i for i, x in enumerate(t) if x > END - 3 * 86400]
    acc += [a[i] for i in keep]
    ts += [t[i] for i in keep]
    res = run(acc, ts)
    pair = [p for p in res.pairs if (p["a"], p["b"]) == ("M00001", "M00002")]
    assert not pair or pair[0]["surprise"] < res.cut
    assert ("M00001", "M00002") not in flagged(res)


def test_market_wide_bursts_are_dropped_like_stop_words():
    rng = np.random.default_rng(3)
    acc, ts = background(rng)
    # three minutes in which 250 accounts all act: shared minutes, but meaningless
    for m in range(3):
        t = END - 3 * 86400 + m * 60
        for a in range(250):
            acc.append(f"A{a:05d}")
            ts.append(t + rng.integers(0, 59))
    res = run(acc, ts)
    assert res.stop_minutes >= 3
    assert flagged(res) == set()
