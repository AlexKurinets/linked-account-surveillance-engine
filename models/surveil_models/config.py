"""Shared configuration: the same JSON files the TypeScript engine reads."""

import json
import os
from pathlib import Path


def config_dir() -> Path:
    env = os.environ.get("SURV_CONFIG_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "config"


def load_engine() -> dict:
    return json.loads((config_dir() / "engine.json").read_text())


def load_rules() -> dict:
    return json.loads((config_dir() / "rules.json").read_text())


def score_feature_names(engine: dict, rules: dict) -> list[str]:
    """Must match scoreFeatureNames() in src/config.ts."""
    return (
        ["intercept"]
        + [f"rule:{r['id']}" for r in rules["rules"]]
        + [e["name"] for e in engine["scoring"]["extra_features"]]
    )


def prior(engine: dict, rules: dict) -> tuple[list[float], list[float]]:
    """Prior means (the analysts' weights) and standard deviations, in feature order."""
    s = engine["scoring"]
    means = [s["intercept_prior_mean"]] + [r["weight"] for r in rules["rules"]] + [e["prior_mean"] for e in s["extra_features"]]
    sds = [s["intercept_prior_sd"]] + [s["weight_prior_sd"]] * (len(means) - 1)
    return means, sds


def database_url() -> str:
    return os.environ.get("DATABASE_URL", "postgres://surv:surv@localhost:5546/surv")
